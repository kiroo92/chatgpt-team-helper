import express from 'express'
import { getDatabase, saveDatabase } from '../database/init.js'
import { upstreamApiAuth } from '../middleware/upstream-api-auth.js'
import { withLocks } from '../utils/locks.js'
import { getUpstreamSettings } from '../utils/upstream-settings.js'
import { getChannels, normalizeChannelKey } from '../utils/channels.js'
import { DOWNSTREAM_SOLD_MESSAGE, redeemCodeInternal, RedemptionError } from './redemption-codes.js'
import { normalizeProviderType } from '../services/upstream-provider.js'
import { getDownstreamOrderItemByPublicCode } from '../utils/downstream-order-items.js'

const router = express.Router()

const normalizeChannel = (value, fallback = 'common') => normalizeChannelKey(value, fallback)
const DOWNSTREAM_MAPPING_ORDER_UNPAID_MESSAGE = '映射码对应订单未完成支付'

const isInvalidBusinessError = (error) => {
  const statusCode = Number(error?.statusCode || 0)
  if (statusCode > 0 && statusCode < 500) return true
  const message = String(error?.message || '').trim()
  return (
    message.includes('不存在') ||
    message.includes('已使用') ||
    message.includes('已失效') ||
    message.includes('不可用') ||
    message.includes('渠道') ||
    message.includes('绑定') ||
    message.includes('下游')
  )
}

const syncDownstreamRedeemedItemState = (db, item) => {
  if (!db || !item?.id || item.redeemedAt || !item.codeId) return item

  const result = db.exec(
    `
      SELECT redeemed_by, redeemed_at
      FROM redemption_codes
      WHERE id = ?
      LIMIT 1
    `,
    [item.codeId]
  )
  const row = result[0]?.values?.[0]
  const redeemedBy = row?.[0] ? String(row[0]).trim() : ''
  const redeemedAt = row?.[1] || null
  if (!redeemedAt) return item

  db.run(
    `
      UPDATE downstream_order_items
      SET redeem_email = COALESCE(NULLIF(redeem_email, ''), NULLIF(?, '')),
          redeemed_at = COALESCE(redeemed_at, ?),
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
    `,
    [redeemedBy, redeemedAt, item.id]
  )
  saveDatabase()

  return getDownstreamOrderItemByPublicCode(db, item.publicCode) || {
    ...item,
    redeemEmail: redeemedBy || item.redeemEmail || '',
    redeemedAt
  }
}

const buildDownstreamPublicCodeCheckResponse = ({ item, requestedChannel, channelsByKey }) => {
  const actualChannel = normalizeChannel(item?.channelKey, 'common')
  if (requestedChannel && actualChannel !== requestedChannel) {
    return {
      ok: false,
      status: 'invalid',
      message: '卡密渠道不匹配',
      data: {
        available: false,
        channel: actualChannel
      }
    }
  }

  if (!item?.realCode) {
    return {
      ok: false,
      status: 'invalid',
      message: '映射码对应真实卡密不存在',
      data: {
        available: false,
        channel: actualChannel
      }
    }
  }

  const orderStatus = String(item.orderStatus || '').trim()
  if (orderStatus !== 'paid') {
    return {
      ok: false,
      status: 'invalid',
      message: orderStatus === 'refunded' ? '映射码已失效' : DOWNSTREAM_MAPPING_ORDER_UNPAID_MESSAGE,
      data: {
        available: false,
        channel: actualChannel
      }
    }
  }

  if (item.supplierStatus === 'invalid') {
    return {
      ok: false,
      status: 'invalid',
      message: '卡密已失效',
      data: {
        available: false,
        channel: actualChannel
      }
    }
  }

  if (item.supplierStatus === 'used') {
    return {
      ok: false,
      status: 'used',
      message: '卡密已使用',
      data: {
        available: false,
        channel: actualChannel
      }
    }
  }

  if (item.redeemedAt) {
    return {
      ok: false,
      status: 'used',
      message: '卡密已使用',
      data: {
        available: false,
        channel: actualChannel,
        redeemedAt: item.redeemedAt || null
      }
    }
  }

  if (item.supplierStatus === 'processing') {
    return {
      ok: false,
      status: 'failed',
      message: '卡密正在处理中',
      data: {
        available: false,
        channel: actualChannel,
        retryable: true
      }
    }
  }

  const channelConfig = channelsByKey.get(actualChannel)
  return {
    ok: true,
    status: 'available',
    message: '卡密可用',
    data: {
      available: true,
      channel: actualChannel,
      redeemMode: channelConfig?.redeemMode || 'code',
      providerType: normalizeProviderType(channelConfig?.providerType, 'local'),
      fulfillmentMode: String(item.fulfillmentMode || '').trim() || 'internal_invite',
      codeType: 'downstream_public_code'
    }
  }
}

router.use(upstreamApiAuth)

router.get('/health', async (req, res) => {
  try {
    const settings = await getUpstreamSettings()
    return res.json({
      ok: true,
      status: 'ok',
      message: 'upstream api available',
      data: {
        providerEnabled: Boolean(settings.providerEnabled),
        providerType: String(settings.providerType || 'custom-http'),
        supplierName: String(settings.supplierName || '')
      }
    })
  } catch (error) {
    console.error('[Upstream API] health error:', error)
    return res.status(500).json({ ok: false, status: 'failed', message: 'upstream api unavailable' })
  }
})

router.post('/cards/check', async (req, res) => {
  try {
    const code = String(req.body?.code || '').trim()
    const requestedChannel = normalizeChannel(req.body?.channel, '')
    if (!code) {
      return res.status(400).json({ ok: false, status: 'invalid', message: '缺少卡密' })
    }

    const db = await getDatabase()
    const { byKey: channelsByKey } = await getChannels(db)
    let downstreamItem = getDownstreamOrderItemByPublicCode(db, code)
    if (downstreamItem) {
      downstreamItem = syncDownstreamRedeemedItemState(db, downstreamItem)
      return res.json(buildDownstreamPublicCodeCheckResponse({
        item: downstreamItem,
        requestedChannel,
        channelsByKey
      }))
    }

    const result = db.exec(
      `
        SELECT code, is_redeemed, channel, redeemed_at, fulfillment_mode, supplier_status, reserved_for_order_no, is_downstream_sold
        FROM redemption_codes
        WHERE code = ?
        LIMIT 1
      `,
      [code]
    )

    const row = result[0]?.values?.[0]
    if (!row) {
      return res.json({ ok: false, status: 'invalid', message: '卡密不存在', data: { available: false } })
    }

    const actualChannel = normalizeChannel(row[2], 'common')
    if (requestedChannel && actualChannel !== requestedChannel) {
      return res.json({ ok: false, status: 'invalid', message: '卡密渠道不匹配', data: { available: false, channel: actualChannel } })
    }

    const supplierStatus = String(row[5] || '').trim().toLowerCase() || 'pending'
    const reservedForOrderNo = String(row[6] || '').trim()
    const isDownstreamSold = Number(row[7] || 0) === 1

    if (isDownstreamSold) {
      return res.json({
        ok: false,
        status: 'invalid',
        message: DOWNSTREAM_SOLD_MESSAGE,
        data: {
          available: false,
          channel: actualChannel
        }
      })
    }

    if (supplierStatus === 'invalid') {
      return res.json({ ok: false, status: 'invalid', message: '卡密已失效', data: { available: false, channel: actualChannel } })
    }

    if (supplierStatus === 'used') {
      return res.json({ ok: false, status: 'used', message: '卡密已使用', data: { available: false, channel: actualChannel } })
    }

    if (Number(row[1] || 0) === 1) {
      return res.json({
        ok: false,
        status: 'used',
        message: '卡密已使用',
        data: {
          available: false,
          channel: actualChannel,
          redeemedAt: row[3] || null
        }
      })
    }

    if (supplierStatus === 'processing') {
      return res.json({
        ok: false,
        status: 'failed',
        message: '卡密正在处理中',
        data: {
          available: false,
          channel: actualChannel,
          retryable: true
        }
      })
    }

    if (reservedForOrderNo) {
      return res.json({
        ok: false,
        status: 'failed',
        message: '卡密已被订单占用',
        data: {
          available: false,
          channel: actualChannel,
          retryable: true
        }
      })
    }

    const channelConfig = channelsByKey.get(actualChannel)
    return res.json({
      ok: true,
      status: 'available',
      message: '卡密可用',
      data: {
        available: true,
        channel: actualChannel,
        redeemMode: channelConfig?.redeemMode || 'code',
        providerType: normalizeProviderType(channelConfig?.providerType, 'local'),
        fulfillmentMode: String(row[4] || '').trim() || 'internal_invite'
      }
    })
  } catch (error) {
    console.error('[Upstream API] check error:', error)
    return res.status(500).json({ ok: false, status: 'failed', message: '查询卡密失败' })
  }
})

router.post('/cards/redeem', async (req, res) => {
  try {
    const code = String(req.body?.code || '').trim()
    const email = String(req.body?.email || '').trim()
    const requestedChannel = normalizeChannel(req.body?.channel, '')
    if (!code || !email) {
      return res.status(400).json({ ok: false, status: 'invalid', message: '缺少邮箱或卡密' })
    }

    const db = await getDatabase()
    const publicItem = getDownstreamOrderItemByPublicCode(db, code)
    if (publicItem) {
      const actualChannel = normalizeChannel(publicItem.channelKey, 'common')
      if (requestedChannel && actualChannel !== requestedChannel) {
        return res.json({
          ok: false,
          status: 'invalid',
          message: '卡密渠道不匹配',
          retryable: false,
          data: {
            channel: actualChannel
          }
        })
      }

      const lockKeys = ['purchase', `downstream-public-code:${publicItem.publicCode}`, `upstream-redeem:${publicItem.publicCode}`]
      if (publicItem.realCode) {
        lockKeys.push(`redemption-code:${publicItem.realCode}`)
      }

      const downstreamResult = await withLocks(lockKeys, async () => {
        let item = getDownstreamOrderItemByPublicCode(db, code)
        if (!item) {
          return { ok: false, status: 'invalid', message: '映射码不存在或已失效', retryable: false }
        }

        item = syncDownstreamRedeemedItemState(db, item)
        if (!item.realCode) {
          return { ok: false, status: 'invalid', message: '映射码对应真实卡密不存在', retryable: false }
        }
        const orderStatus = String(item.orderStatus || '').trim()
        if (orderStatus !== 'paid') {
          return {
            ok: false,
            status: 'invalid',
            message: orderStatus === 'refunded' ? '映射码已失效' : DOWNSTREAM_MAPPING_ORDER_UNPAID_MESSAGE,
            retryable: false
          }
        }
        if (item.supplierStatus === 'invalid') {
          return { ok: false, status: 'invalid', message: '卡密已失效', retryable: false }
        }
        if (item.redeemedAt) {
          return {
            ok: false,
            status: 'used',
            message: '卡密已使用',
            retryable: false,
            data: {
              redeemedAt: item.redeemedAt || null
            }
          }
        }

        try {
          const redemption = await redeemCodeInternal({
            code: item.realCode,
            email,
            channel: actualChannel,
            skipCodeFormatValidation: true,
            allowCommonChannelFallback: true,
            allowDownstreamSoldRedeem: true,
            skipReservedOrderValidation: true
          })

          db.run(
            `
              UPDATE downstream_order_items
              SET redeem_email = ?,
                  redeemed_at = COALESCE(redeemed_at, DATETIME('now', 'localtime')),
                  updated_at = DATETIME('now', 'localtime')
              WHERE id = ?
                AND redeemed_at IS NULL
            `,
            [String(email || '').trim(), item.id]
          )
          saveDatabase()

          return {
            ok: true,
            message: redemption.data?.message || '兑换成功',
            data: {
              ...(redemption.data || {}),
              publicCode: item.publicCode
            }
          }
        } catch (error) {
          if (error instanceof RedemptionError && error.message === '该兑换码已被使用') {
            const updatedItem = syncDownstreamRedeemedItemState(db, item)
            if (updatedItem?.redeemedAt) {
              return {
                ok: false,
                status: 'used',
                message: '卡密已使用',
                retryable: false,
                data: {
                  redeemedAt: updatedItem.redeemedAt || null
                }
              }
            }
          }
          throw error
        }
      })

      if (!downstreamResult.ok) {
        return res.json({
          ok: false,
          status: downstreamResult.status || 'failed',
          message: downstreamResult.message || '映射码兑换失败',
          retryable: Boolean(downstreamResult.retryable),
          data: downstreamResult.data || null
        })
      }

      return res.json({
        ok: true,
        status: 'success',
        message: downstreamResult.message,
        data: downstreamResult.data || null
      })
    }

    const result = await withLocks(
      ['purchase', `redemption-code:${code}`, `upstream-redeem:${code}`],
      () => redeemCodeInternal({
        code,
        email,
        channel: requestedChannel || 'common',
        skipCodeFormatValidation: true,
        allowCommonChannelFallback: true
      })
    )

    return res.json({
      ok: true,
      status: 'success',
      message: result.data?.message || '兑换成功',
      data: result.data
    })
  } catch (error) {
    if (error instanceof RedemptionError) {
      return res.json({
        ok: false,
        status: isInvalidBusinessError(error) ? 'invalid' : 'failed',
        message: error.message,
        retryable: !isInvalidBusinessError(error),
        data: error.payload || null
      })
    }

    console.error('[Upstream API] redeem error:', error)
    return res.status(500).json({
      ok: false,
      status: 'failed',
      message: '上游兑换失败',
      retryable: true
    })
  }
})

export default router
