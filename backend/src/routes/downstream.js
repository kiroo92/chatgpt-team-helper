import express from 'express'
import axios from 'axios'
import crypto from 'crypto'
import { getDatabase, saveDatabase } from '../database/init.js'
import { withLocks } from '../utils/locks.js'
import { requireFeatureEnabled } from '../middleware/feature-flags.js'
import { getDownstreamSaleSettings } from '../utils/downstream-sale-settings.js'
import { getZpaySettings } from '../utils/zpay-settings.js'
import { resolvePublicBaseUrl } from '../utils/public-base-url.js'
import { consumeRateLimit, getRequestClientIp } from '../utils/request-guard.js'
import {
  cleanupExpiredOrders,
  fetchOrder,
  ORDER_SCENE_DOWNSTREAM,
  resolvePurchaseOrderNoByZpayTradeNo,
  syncOrderStatusFromZpay
} from './purchase.js'
import {
  listDownstreamOrderItems,
  releaseReservedCodesByOrderNo
} from '../utils/downstream-order-items.js'

const router = express.Router()

router.use(requireFeatureEnabled('payment'))

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DOWNSTREAM_PRODUCT_KEY = 'downstream-sale'
const DOWNSTREAM_SERVICE_DAYS = 30
const DOWNSTREAM_ORDER_TYPE = 'warranty'
const SUPPLIER_STATUS_INVALID = 'invalid'
const SUPPLIER_STATUS_USED = 'used'
const SUPPLIER_STATUS_PROCESSING = 'processing'

const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase()

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const parseMoney = (value) => {
  const parsed = Number.parseFloat(String(value ?? ''))
  if (!Number.isFinite(parsed)) return null
  return Math.round(parsed * 100) / 100
}

const formatMoney = (value) => {
  const parsed = parseMoney(value)
  if (parsed === null || parsed <= 0) return null
  return parsed.toFixed(2)
}

const toMoneyCents = (value) => {
  const parsed = parseMoney(value)
  if (parsed === null || parsed <= 0) return null
  return Math.round(parsed * 100)
}

const formatMoneyFromCents = (value) => {
  const cents = Number(value)
  if (!Number.isFinite(cents) || cents <= 0) return null
  return (cents / 100).toFixed(2)
}

const multiplyMoney = (value, quantity) => {
  const cents = toMoneyCents(value)
  const normalizedQuantity = Math.max(1, Number(quantity) || 1)
  if (cents === null) return null
  return formatMoneyFromCents(cents * normalizedQuantity)
}

const parseQuantity = (value) => {
  const maxQuantity = Math.max(1, toInt(process.env.DOWNSTREAM_MAX_ORDER_QUANTITY, 20))
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return null
  if (parsed <= 0) return null
  if (parsed > maxQuantity) return null
  return parsed
}

const getDownstreamCreateRateLimitWindowMs = () => Math.max(60 * 1000, toInt(process.env.DOWNSTREAM_CREATE_RATE_LIMIT_WINDOW_MS, 10 * 60 * 1000))
const getDownstreamCreateRateLimitMaxPerIp = () => Math.max(1, toInt(process.env.DOWNSTREAM_CREATE_RATE_LIMIT_MAX_PER_IP, 10))
const getDownstreamPendingOrderLimitPerEmail = () => Math.max(1, toInt(process.env.DOWNSTREAM_PENDING_ORDER_LIMIT_PER_EMAIL, 3))
const getDownstreamPendingOrderLimitPerIp = () => Math.max(1, toInt(process.env.DOWNSTREAM_PENDING_ORDER_LIMIT_PER_IP, 5))

const countPendingDownstreamOrdersByEmail = (db, email) => {
  const normalizedEmail = normalizeEmail(email)
  if (!db || !normalizedEmail) return 0

  const result = db.exec(
    `
      SELECT COUNT(*)
      FROM purchase_orders
      WHERE paid_at IS NULL
        AND status IN ('created', 'pending_payment')
        AND order_scene = ?
        AND LOWER(TRIM(email)) = ?
    `,
    [ORDER_SCENE_DOWNSTREAM, normalizedEmail]
  )

  return Number(result[0]?.values?.[0]?.[0] || 0)
}

const countPendingDownstreamOrdersByClientIp = (db, clientIp) => {
  const normalizedClientIp = String(clientIp || '').trim()
  if (!db || !normalizedClientIp) return 0

  const result = db.exec(
    `
      SELECT COUNT(*)
      FROM purchase_orders
      WHERE paid_at IS NULL
        AND status IN ('created', 'pending_payment')
        AND order_scene = ?
        AND TRIM(COALESCE(client_ip, '')) = ?
    `,
    [ORDER_SCENE_DOWNSTREAM, normalizedClientIp]
  )

  return Number(result[0]?.values?.[0]?.[0] || 0)
}

const safeSnippet = (value, limit = 420) => {
  if (value == null) return ''
  const raw = typeof value === 'string' ? value : (() => {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  })()
  const normalized = raw.replace(/\s+/g, ' ').trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, limit)}...`
}

const md5 = (value) => crypto.createHash('md5').update(String(value), 'utf8').digest('hex')

const buildZpaySign = (params, key) => {
  const entries = Object.entries(params || {})
    .filter(([k, v]) => {
      if (!k) return false
      if (k === 'sign' || k === 'sign_type') return false
      if (v === undefined || v === null) return false
      const str = String(v).trim()
      return str.length > 0
    })
    .sort(([a], [b]) => (a === b ? 0 : a > b ? 1 : -1))
    .map(([k, v]) => `${k}=${String(v).trim()}`)
    .join('&')

  return md5(`${entries}${key}`)
}

const normalizeZpayResponseData = (raw) => {
  if (raw == null) return { data: null, rawText: '' }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return { data: null, rawText: '' }
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return { data: JSON.parse(trimmed), rawText: trimmed }
      } catch {
        return { data: null, rawText: trimmed }
      }
    }
    return { data: null, rawText: trimmed }
  }
  return { data: raw, rawText: '' }
}

const generateOrderNo = () => {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const rand = Math.floor(Math.random() * 1e6).toString().padStart(6, '0')
  return `${stamp}${rand}`
}

const getDownstreamSaleConfig = async (db) => {
  const settings = await getDownstreamSaleSettings(db)
  const payMethods = []
  if (settings.payAlipayEnabled) payMethods.push('alipay')
  if (settings.payWxpayEnabled) payMethods.push('wxpay')
  return {
    enabled: Boolean(settings.enabled),
    productName: String(settings.productName || '').trim(),
    amount: String(settings.amount || '').trim(),
    payAlipayEnabled: Boolean(settings.payAlipayEnabled),
    payWxpayEnabled: Boolean(settings.payWxpayEnabled),
    payMethods
  }
}

const getZpayConfig = async (db) => {
  const settings = await getZpaySettings(db)
  return {
    pid: String(settings.pid || '').trim(),
    key: String(settings.key || '').trim(),
    baseUrl: String(settings.baseUrl || '').trim().replace(/\/+$/, '') || 'https://zpayz.cn'
  }
}

const getDownstreamAvailabilitySql = () => `
  FROM redemption_codes rc
  JOIN channels ch
    ON LOWER(TRIM(ch.key)) = COALESCE(NULLIF(LOWER(TRIM(rc.channel)), ''), 'common')
  LEFT JOIN gpt_accounts ga
    ON LOWER(TRIM(ga.email)) = LOWER(TRIM(rc.account_email))
  WHERE ch.is_active = 1
    AND COALESCE(ch.allow_downstream_sale, 0) = 1
    AND LOWER(TRIM(COALESCE(ch.redeem_mode, ''))) IN ('code', 'external-card')
    AND rc.is_redeemed = 0
    AND COALESCE(rc.is_downstream_sold, 0) = 0
    AND (rc.reserved_for_order_no IS NULL OR rc.reserved_for_order_no = '')
    AND (rc.reserved_for_entry_id IS NULL OR rc.reserved_for_entry_id = 0)
    AND (
      LOWER(TRIM(COALESCE(ch.redeem_mode, ''))) = 'external-card'
      OR (
        rc.account_email IS NOT NULL
        AND ga.is_open = 1
        AND ga.user_count < 6
        AND DATE(ga.created_at) = DATE('now', 'localtime')
      )
    )
    AND (
      LOWER(TRIM(COALESCE(ch.redeem_mode, ''))) != 'external-card'
      OR COALESCE(NULLIF(LOWER(TRIM(rc.supplier_status)), ''), 'pending') NOT IN (?, ?, ?)
    )
`

const getDownstreamAvailableCodeCount = (db) => {
  const result = db.exec(
    `
      SELECT COUNT(*)
      ${getDownstreamAvailabilitySql()}
    `,
    [SUPPLIER_STATUS_INVALID, SUPPLIER_STATUS_USED, SUPPLIER_STATUS_PROCESSING]
  )
  return Number(result[0]?.values?.[0]?.[0] || 0)
}

const reserveDownstreamCodes = (db, { orderNo, email, quantity }) => {
  const normalizedQuantity = Math.max(1, Number(quantity) || 1)
  const result = db.exec(
    `
      SELECT rc.id,
             rc.code,
             rc.account_email,
             COALESCE(NULLIF(LOWER(TRIM(rc.channel)), ''), 'common') AS channel_key
      ${getDownstreamAvailabilitySql()}
      ORDER BY ch.sort_order ASC, rc.created_at ASC, rc.id ASC
      LIMIT ?
    `,
    [SUPPLIER_STATUS_INVALID, SUPPLIER_STATUS_USED, SUPPLIER_STATUS_PROCESSING, normalizedQuantity]
  )
  const rows = result[0]?.values || []
  if (rows.length < normalizedQuantity) return null

  const codeIds = rows.map(row => Number(row[0]))
  const placeholders = codeIds.map(() => '?').join(', ')
  db.run(
    `
      UPDATE redemption_codes
      SET reserved_for_order_no = ?,
          reserved_for_order_email = ?,
          reserved_at = DATETIME('now', 'localtime'),
          updated_at = DATETIME('now', 'localtime')
      WHERE id IN (${placeholders})
        AND is_redeemed = 0
        AND COALESCE(is_downstream_sold, 0) = 0
        AND (reserved_for_order_no IS NULL OR reserved_for_order_no = '')
        AND (reserved_for_entry_id IS NULL OR reserved_for_entry_id = 0)
    `,
    [orderNo, email, ...codeIds]
  )

  const modified = typeof db.getRowsModified === 'function' ? db.getRowsModified() : 0
  if (modified < normalizedQuantity) {
    releaseReservedCodesByOrderNo(db, orderNo)
    return null
  }

  return rows.map(row => ({
    codeId: Number(row[0]),
    code: row[1] ? String(row[1]) : '',
    accountEmail: row[2] ? String(row[2]).trim() : '',
    channelKey: row[3] ? String(row[3]).trim().toLowerCase() : 'common'
  }))
}

const buildOrderItemsPayload = (items) => (
  (Array.isArray(items) ? items : []).map(item => ({
    publicCode: item.publicCode,
    status: item.redeemedAt ? 'redeemed' : 'unused',
    redeemedAt: item.redeemedAt || null
  }))
)

const buildOrderResponse = (order, items = []) => ({
  orderNo: order.orderNo,
  tradeNo: order.zpayTradeNo || null,
  email: order.email,
  productName: order.productName,
  amount: order.amount,
  unitAmount: formatMoneyFromCents(Math.round(((toMoneyCents(order.amount) || 0) / Math.max(1, Number(order.quantity) || 1)))),
  orderScene: order.orderScene,
  quantity: Math.max(1, Number(order.quantity) || 1),
  payType: order.payType || null,
  payUrl: order.payUrl || null,
  qrcode: order.qrcode || null,
  img: order.img || null,
  status: order.status,
  createdAt: order.createdAt,
  paidAt: order.paidAt || null,
  inviteStatus: order.inviteStatus || null,
  redeemError: order.redeemError || null,
  refundedAt: order.refundedAt || null,
  refundAmount: order.refundAmount || null,
  refundMessage: order.refundMessage || null,
  items: buildOrderItemsPayload(items)
})

router.get('/meta', async (req, res) => {
  try {
    const db = await getDatabase()
    const settings = await getDownstreamSaleConfig(db)
    if (!settings.enabled) {
      return res.json({
        enabled: false,
        productName: settings.productName,
        amount: settings.amount,
        payAlipayEnabled: settings.payAlipayEnabled,
        payWxpayEnabled: settings.payWxpayEnabled,
        payMethods: settings.payMethods,
        maxOrderQuantity: Math.max(1, toInt(process.env.DOWNSTREAM_MAX_ORDER_QUANTITY, 20)),
        availableCount: 0
      })
    }

    await withLocks(['purchase'], async () => {
      const released = cleanupExpiredOrders(db, { expireMinutes: Math.max(5, toInt(process.env.PURCHASE_ORDER_EXPIRE_MINUTES, 15)) })
      if (released) {
        saveDatabase()
      }
    })

    return res.json({
      enabled: true,
      productName: settings.productName,
      amount: settings.amount,
      payAlipayEnabled: settings.payAlipayEnabled,
      payWxpayEnabled: settings.payWxpayEnabled,
      payMethods: settings.payMethods,
      maxOrderQuantity: Math.max(1, toInt(process.env.DOWNSTREAM_MAX_ORDER_QUANTITY, 20)),
      availableCount: getDownstreamAvailableCodeCount(db)
    })
  } catch (error) {
    console.error('[Downstream] get meta error:', error)
    return res.status(500).json({ error: '加载下游售码信息失败' })
  }
})

router.post('/orders', async (req, res) => {
  const email = normalizeEmail(req.body?.email)
  const payType = String(req.body?.type || '').trim().toLowerCase()
  const quantity = parseQuantity(req.body?.quantity)
  const clientIp = getRequestClientIp(req)

  if (!email) return res.status(400).json({ error: '请输入邮箱地址' })
  if (!EMAIL_REGEX.test(email)) return res.status(400).json({ error: '请输入有效的邮箱地址' })
  if (!['alipay', 'wxpay'].includes(payType)) return res.status(400).json({ error: '支付方式不支持' })
  if (!quantity) return res.status(400).json({ error: '请输入有效的购买数量' })

  const createRateLimit = consumeRateLimit({
    key: clientIp ? `downstream:create:${clientIp}` : '',
    limit: getDownstreamCreateRateLimitMaxPerIp(),
    windowMs: getDownstreamCreateRateLimitWindowMs()
  })
  if (!createRateLimit.ok) {
    const retryAfterSeconds = Math.max(1, Math.ceil(Number(createRateLimit.retryAfterMs || 0) / 1000))
    res.set('Retry-After', String(retryAfterSeconds))
    return res.status(429).json({ error: '下单过于频繁，请稍后再试' })
  }

  const orderNo = generateOrderNo()

  try {
    const db = await getDatabase()
    const downstreamSettings = await getDownstreamSaleConfig(db)
    if (!downstreamSettings.enabled) {
      return res.status(503).json({ error: '下游售码暂未开启' })
    }
    if (!downstreamSettings.payMethods.length) {
      return res.status(503).json({ error: '下游支付方式未配置，请联系管理员' })
    }
    if (!downstreamSettings.payMethods.includes(payType)) {
      return res.status(400).json({ error: '当前支付方式未启用' })
    }

    const totalAmount = multiplyMoney(downstreamSettings.amount, quantity)
    if (!totalAmount) {
      return res.status(500).json({ error: '下游售价配置异常，请联系管理员' })
    }

    const { pid, key, baseUrl } = await getZpayConfig(db)
    if (!pid || !key) {
      return res.status(500).json({ error: '支付未配置，请联系管理员' })
    }

    const reservation = await withLocks(['purchase'], async () => {
      const released = cleanupExpiredOrders(db, { expireMinutes: Math.max(5, toInt(process.env.PURCHASE_ORDER_EXPIRE_MINUTES, 15)) })
      if (released) {
        saveDatabase()
      }

      const pendingOrdersForEmail = countPendingDownstreamOrdersByEmail(db, email)
      if (pendingOrdersForEmail >= getDownstreamPendingOrderLimitPerEmail()) {
        return { ok: false, status: 429, error: '当前邮箱待支付订单过多，请先完成支付或等待旧订单过期' }
      }

      const pendingOrdersForClientIp = countPendingDownstreamOrdersByClientIp(db, clientIp)
      if (pendingOrdersForClientIp >= getDownstreamPendingOrderLimitPerIp()) {
        return { ok: false, status: 429, error: '当前网络待支付订单过多，请稍后再试' }
      }

      const reserved = reserveDownstreamCodes(db, { orderNo, email, quantity })
      if (!reserved) {
        return { ok: false, status: 409, error: '可用库存不足，请稍后再试' }
      }

      db.run(
        `
          INSERT INTO purchase_orders (
            order_no, email, product_name, amount, service_days, order_type, order_scene, quantity, product_key, code_channel, client_ip, pay_type, status,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))
        `,
        [
          orderNo,
          email,
          downstreamSettings.productName,
          totalAmount,
          DOWNSTREAM_SERVICE_DAYS,
          DOWNSTREAM_ORDER_TYPE,
          ORDER_SCENE_DOWNSTREAM,
          quantity,
          DOWNSTREAM_PRODUCT_KEY,
          null,
          clientIp || null,
          payType
        ]
      )
      saveDatabase()

      return { ok: true, reserved }
    })

    if (!reservation.ok) {
      return res.status(reservation.status || 409).json({ error: reservation.error })
    }

    const notifyUrl = `${await resolvePublicBaseUrl(req, db)}/notify`
    const payParams = {
      pid,
      type: payType,
      out_trade_no: orderNo,
      notify_url: notifyUrl,
      return_url: notifyUrl,
      name: quantity > 1 ? `${downstreamSettings.productName} x${quantity}` : downstreamSettings.productName,
      money: totalAmount,
      clientip: clientIp,
      device: 'pc',
      param: `scene=downstream&email=${email}&quantity=${quantity}`
    }

    const sign = buildZpaySign({ ...payParams, sign_type: 'MD5' }, key)
    const form = new URLSearchParams()
    Object.entries({ ...payParams, sign, sign_type: 'MD5' }).forEach(([k, v]) => form.append(k, String(v)))

    const zpayResponse = await axios.post(`${baseUrl}/mapi.php`, form, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
      validateStatus: () => true
    })

    const normalized = normalizeZpayResponseData(zpayResponse?.data)
    const data = normalized.data
    const rawText = normalized.rawText

    if (zpayResponse.status !== 200) {
      const message = `支付通道异常（HTTP ${zpayResponse.status}）`
      await withLocks(['purchase', `purchase:${orderNo}`], async () => {
        db.run(
          `UPDATE purchase_orders SET status = 'failed', refund_message = ?, updated_at = DATETIME('now', 'localtime') WHERE order_no = ?`,
          [message, orderNo]
        )
        releaseReservedCodesByOrderNo(db, orderNo)
        saveDatabase()
      })
      return res.status(502).json({ error: message })
    }

    if (!data || String(data.code) !== '1') {
      const codeValue = data?.code != null ? String(data.code) : ''
      const message = data?.msg
        ? String(data.msg)
        : codeValue
          ? `支付下单失败（code=${codeValue}）`
          : rawText
            ? '支付下单失败（响应格式异常）'
            : '支付下单失败'

      await withLocks(['purchase', `purchase:${orderNo}`], async () => {
        db.run(
          `UPDATE purchase_orders SET status = 'failed', refund_message = ?, updated_at = DATETIME('now', 'localtime') WHERE order_no = ?`,
          [message, orderNo]
        )
        releaseReservedCodesByOrderNo(db, orderNo)
        saveDatabase()
      })
      return res.status(502).json({ error: message })
    }

    db.run(
      `
        UPDATE purchase_orders
        SET status = 'pending_payment',
            zpay_oid = ?,
            zpay_trade_no = ?,
            zpay_payurl = ?,
            zpay_qrcode = ?,
            zpay_img = ?,
            updated_at = DATETIME('now', 'localtime')
        WHERE order_no = ?
      `,
      [data.O_id || null, data.trade_no || null, data.payurl || null, data.qrcode || null, data.img || null, orderNo]
    )
    saveDatabase()

    return res.json({
      orderNo,
      quantity,
      amount: totalAmount,
      productName: downstreamSettings.productName,
      unitAmount: downstreamSettings.amount,
      payType,
      payUrl: data.payurl || null,
      qrcode: data.qrcode || null,
      img: data.img || null
    })
  } catch (error) {
    console.error('[Downstream] create order error:', {
      orderNo,
      message: error?.message || String(error),
      code: error?.code,
      status: error?.response?.status,
      responseSnippet: safeSnippet(error?.response?.data)
    })

    const db = await getDatabase().catch(() => null)
    if (db) {
      try {
        await withLocks(['purchase', `purchase:${orderNo}`], async () => {
          db.run(
            `UPDATE purchase_orders SET status = 'failed', refund_message = ?, updated_at = DATETIME('now', 'localtime') WHERE order_no = ? AND paid_at IS NULL`,
            ['create_order_exception', orderNo]
          )
          releaseReservedCodesByOrderNo(db, orderNo)
          saveDatabase()
        })
      } catch {
        // ignore follow-up cleanup failures
      }
    }

    return res.status(500).json({ error: '创建订单失败，请稍后再试' })
  }
})

router.get('/orders/:orderNo', async (req, res) => {
  const requestedOrderNo = String(req.params.orderNo || '').trim()
  const email = normalizeEmail(req.query?.email)
  if (!requestedOrderNo) return res.status(400).json({ error: '缺少订单号' })
  if (!email) return res.status(400).json({ error: '缺少邮箱' })
  if (!EMAIL_REGEX.test(email)) return res.status(400).json({ error: '邮箱格式不正确' })

  try {
    const db = await getDatabase()
    let resolvedOrderNo = requestedOrderNo
    let order = fetchOrder(db, requestedOrderNo)
    if (!order) {
      const mapped = resolvePurchaseOrderNoByZpayTradeNo(db, requestedOrderNo)
      if (mapped) {
        resolvedOrderNo = mapped
        order = fetchOrder(db, mapped)
      }
    }
    if (!order || order.orderScene !== ORDER_SCENE_DOWNSTREAM) {
      return res.status(404).json({ error: '订单不存在' })
    }
    if (normalizeEmail(order.email) !== email) {
      return res.status(403).json({ error: '订单信息不匹配' })
    }

    const syncParam = String(req.query?.sync || '').trim().toLowerCase()
    const forceSync = ['1', 'true', 'yes'].includes(syncParam)
    const fallbackDelayMs = Math.max(0, toInt(process.env.PURCHASE_ORDER_QUERY_FALLBACK_DELAY_MS, 60000))
    const createdAtMs = Date.parse(String(order.createdAt || ''))
    const orderAgeMs = Number.isFinite(createdAtMs) ? Date.now() - createdAtMs : 0
    const allowFallbackSync = !forceSync && fallbackDelayMs > 0 && orderAgeMs >= fallbackDelayMs

    if ((order.status === 'created' || order.status === 'pending_payment') && (forceSync || allowFallbackSync)) {
      try {
        await syncOrderStatusFromZpay(db, resolvedOrderNo, { force: forceSync })
        order = fetchOrder(db, resolvedOrderNo) || order
      } catch (error) {
        console.warn('[Downstream] sync order status failed', { orderNo: resolvedOrderNo, message: error?.message || String(error) })
      }
    }

    const items = order.status === 'paid'
      ? listDownstreamOrderItems(db, resolvedOrderNo)
      : []

    return res.json({
      order: buildOrderResponse(order, items)
    })
  } catch (error) {
    console.error('[Downstream] get order error:', error)
    return res.status(500).json({ error: '查询失败，请稍后再试' })
  }
})

export default router
