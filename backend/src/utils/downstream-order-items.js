import crypto from 'crypto'

export const DOWNSTREAM_PUBLIC_CODE_PREFIX = 'DS'

const PUBLIC_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const PUBLIC_CODE_SEGMENT_LENGTH = 4
const PUBLIC_CODE_SEGMENT_COUNT = 3

const normalizeOrderNo = (value) => String(value || '').trim()

export const normalizeDownstreamPublicCode = (value) => String(value || '').trim().toUpperCase()

const buildRandomSegment = (length = PUBLIC_CODE_SEGMENT_LENGTH) => {
  const bytes = crypto.randomBytes(length)
  let segment = ''
  for (let index = 0; index < length; index += 1) {
    segment += PUBLIC_CODE_ALPHABET[bytes[index] % PUBLIC_CODE_ALPHABET.length]
  }
  return segment
}

const downstreamPublicCodeExists = (db, publicCode) => {
  if (!db || !publicCode) return false
  const result = db.exec(
    `
      SELECT 1
      FROM downstream_order_items
      WHERE public_code = ?
      LIMIT 1
    `,
    [publicCode]
  )
  return Boolean(result[0]?.values?.length)
}

export const generateDownstreamPublicCode = (db) => {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const segments = Array.from({ length: PUBLIC_CODE_SEGMENT_COUNT }, () => buildRandomSegment())
    const publicCode = `${DOWNSTREAM_PUBLIC_CODE_PREFIX}-${segments.join('-')}`
    if (!downstreamPublicCodeExists(db, publicCode)) {
      return publicCode
    }
  }

  throw new Error('generate_downstream_public_code_failed')
}

export const listReservedRedemptionCodesByOrderNo = (db, orderNo) => {
  const normalizedOrderNo = normalizeOrderNo(orderNo)
  if (!db || !normalizedOrderNo) return []

  const result = db.exec(
    `
      SELECT id,
             code,
             account_email,
             COALESCE(NULLIF(LOWER(TRIM(channel)), ''), 'common') AS channel_key,
             is_redeemed,
             COALESCE(is_downstream_sold, 0) AS is_downstream_sold,
             downstream_sold_at,
             order_type,
             created_at
      FROM redemption_codes
      WHERE reserved_for_order_no = ?
      ORDER BY created_at ASC, id ASC
    `,
    [normalizedOrderNo]
  )

  const rows = result[0]?.values || []
  return rows.map(row => ({
    codeId: Number(row[0]),
    code: row[1] ? String(row[1]) : '',
    accountEmail: row[2] ? String(row[2]).trim() : '',
    channelKey: row[3] ? String(row[3]).trim().toLowerCase() : 'common',
    isRedeemed: Number(row[4] || 0) === 1,
    isDownstreamSold: Number(row[5] || 0) === 1,
    downstreamSoldAt: row[6] || null,
    orderType: row[7] ? String(row[7]).trim() : '',
    createdAt: row[8] || null
  }))
}

export const releaseReservedCodesByOrderNo = (db, orderNo) => {
  const normalizedOrderNo = normalizeOrderNo(orderNo)
  if (!db || !normalizedOrderNo) return 0

  db.run(
    `
      UPDATE redemption_codes
      SET reserved_for_order_no = NULL,
          reserved_for_order_email = NULL,
          reserved_at = NULL,
          updated_at = DATETIME('now', 'localtime')
      WHERE reserved_for_order_no = ?
        AND is_redeemed = 0
        AND COALESCE(is_downstream_sold, 0) = 0
    `,
    [normalizedOrderNo]
  )

  return typeof db.getRowsModified === 'function' ? db.getRowsModified() : 0
}

export const listDownstreamOrderItems = (db, orderNo) => {
  const normalizedOrderNo = normalizeOrderNo(orderNo)
  if (!db || !normalizedOrderNo) return []

  const result = db.exec(
    `
      SELECT doi.id,
             doi.order_no,
             doi.code_id,
             doi.public_code,
             doi.redeem_email,
             doi.redeemed_at,
             doi.created_at,
             doi.updated_at,
             rc.code,
             COALESCE(NULLIF(LOWER(TRIM(rc.channel)), ''), 'common') AS channel_key,
             rc.order_type
      FROM downstream_order_items doi
      LEFT JOIN redemption_codes rc
        ON rc.id = doi.code_id
      WHERE doi.order_no = ?
      ORDER BY doi.id ASC
    `,
    [normalizedOrderNo]
  )

  const rows = result[0]?.values || []
  return rows.map(row => ({
    id: Number(row[0]),
    orderNo: row[1] ? String(row[1]) : '',
    codeId: Number(row[2]),
    publicCode: row[3] ? String(row[3]) : '',
    redeemEmail: row[4] ? String(row[4]).trim() : '',
    redeemedAt: row[5] || null,
    createdAt: row[6] || null,
    updatedAt: row[7] || null,
    realCode: row[8] ? String(row[8]) : '',
    channelKey: row[9] ? String(row[9]).trim().toLowerCase() : 'common',
    orderType: row[10] ? String(row[10]).trim() : ''
  }))
}

export const getDownstreamOrderItemByPublicCode = (db, publicCode) => {
  const normalizedPublicCode = normalizeDownstreamPublicCode(publicCode)
  if (!db || !normalizedPublicCode) return null

  const result = db.exec(
    `
      SELECT doi.id,
             doi.order_no,
             doi.code_id,
             doi.public_code,
             doi.redeem_email,
             doi.redeemed_at,
             doi.created_at,
             doi.updated_at,
             rc.code,
             COALESCE(NULLIF(LOWER(TRIM(rc.channel)), ''), 'common') AS channel_key,
             rc.order_type,
             rc.fulfillment_mode,
             rc.supplier_status,
             po.status,
             po.refunded_at,
             po.paid_at,
             po.email
      FROM downstream_order_items doi
      JOIN redemption_codes rc
        ON rc.id = doi.code_id
      JOIN purchase_orders po
        ON po.order_no = doi.order_no
      WHERE doi.public_code = ?
      LIMIT 1
    `,
    [normalizedPublicCode]
  )

  const row = result[0]?.values?.[0]
  if (!row) return null

  return {
    id: Number(row[0]),
    orderNo: row[1] ? String(row[1]) : '',
    codeId: Number(row[2]),
    publicCode: row[3] ? String(row[3]) : '',
    redeemEmail: row[4] ? String(row[4]).trim() : '',
    redeemedAt: row[5] || null,
    createdAt: row[6] || null,
    updatedAt: row[7] || null,
    realCode: row[8] ? String(row[8]) : '',
    channelKey: row[9] ? String(row[9]).trim().toLowerCase() : 'common',
    orderType: row[10] ? String(row[10]).trim() : '',
    fulfillmentMode: row[11] ? String(row[11]).trim() : '',
    supplierStatus: row[12] ? String(row[12]).trim().toLowerCase() : '',
    orderStatus: row[13] ? String(row[13]).trim() : '',
    refundedAt: row[14] || null,
    paidAt: row[15] || null,
    orderEmail: row[16] ? String(row[16]).trim() : ''
  }
}

export const getDownstreamOrderItemRefundState = (db, orderNo) => {
  const normalizedOrderNo = normalizeOrderNo(orderNo)
  if (!db || !normalizedOrderNo) {
    return { total: 0, redeemedCount: 0, items: [] }
  }

  const result = db.exec(
    `
      SELECT doi.id,
             doi.code_id,
             doi.public_code,
             doi.redeemed_at,
             rc.is_redeemed,
             rc.redeemed_at,
             rc.code
      FROM downstream_order_items doi
      LEFT JOIN redemption_codes rc
        ON rc.id = doi.code_id
      WHERE doi.order_no = ?
      ORDER BY doi.id ASC
    `,
    [normalizedOrderNo]
  )

  const rows = result[0]?.values || []
  const items = rows.map(row => {
    const itemRedeemedAt = row[3] || null
    const codeRedeemedAt = row[5] || null
    const isCodeRedeemed = Number(row[4] || 0) === 1
    return {
      id: Number(row[0]),
      codeId: Number(row[1]),
      publicCode: row[2] ? String(row[2]) : '',
      redeemedAt: itemRedeemedAt || codeRedeemedAt,
      isRedeemed: Boolean(itemRedeemedAt || codeRedeemedAt || isCodeRedeemed),
      realCode: row[6] ? String(row[6]) : ''
    }
  })

  return {
    total: items.length,
    redeemedCount: items.filter(item => item.isRedeemed).length,
    items
  }
}

export const revokeDownstreamOrderItems = (db, orderNo) => {
  const normalizedOrderNo = normalizeOrderNo(orderNo)
  if (!db || !normalizedOrderNo) {
    return { ok: true, revokedCount: 0, blockedRedeemedCount: 0 }
  }

  const state = getDownstreamOrderItemRefundState(db, normalizedOrderNo)
  if (state.redeemedCount > 0) {
    return {
      ok: false,
      error: 'downstream_code_redeemed',
      blockedRedeemedCount: state.redeemedCount,
      revokedCount: 0
    }
  }

  const codeIds = state.items
    .map(item => Number(item.codeId || 0))
    .filter(codeId => codeId > 0)

  if (codeIds.length > 0) {
    const placeholders = codeIds.map(() => '?').join(', ')
    db.run(
      `
        UPDATE redemption_codes
        SET is_downstream_sold = 0,
            downstream_sold_at = NULL,
            reserved_for_order_no = NULL,
            reserved_for_order_email = NULL,
            reserved_at = NULL,
            updated_at = DATETIME('now', 'localtime')
        WHERE id IN (${placeholders})
          AND COALESCE(is_redeemed, 0) = 0
      `,
      codeIds
    )
  }

  db.run(
    `
      DELETE FROM downstream_order_items
      WHERE order_no = ?
    `,
    [normalizedOrderNo]
  )

  return {
    ok: true,
    revokedCount: state.items.length,
    blockedRedeemedCount: 0
  }
}
