export default {
  // Common
  common: {
    loading: '加载中...',
    refresh: '刷新',
    submit: '提交',
    cancel: '取消',
    save: '保存',
    delete: '删除',
    edit: '编辑',
    copy: '复制',
    copied: '已复制',
    copyFailed: '复制失败，请手动复制',
    success: '成功',
    failed: '失败',
    error: '错误',
    confirm: '确认',
    back: '返回',
    next: '下一页',
    previous: '上一页',
    page: '页',
    total: '共',
    noData: '暂无数据',
    unknown: '未知',
  },

  // Points Exchange
  pointsExchange: {
    title: '积分兑换',
    tabs: {
      exchange: '积分兑换',
      ledger: '变更明细',
    },
    availablePoints: '可用积分',
    availablePointsDesc: '兑换名额或提交提现申请（兑换会向填写的邮箱发送邀请）。',
    currentPoints: '当前积分',

    // Team Seat
    teamSeat: {
      title: '兑换 ChatGPT Team 名额',
      desc: '30 天 · {cost} 积分/个 · 支持批量',
      emailLabel: '接收邀请邮箱',
      emailPlaceholder: '输入邮箱地址，多个邮箱用逗号或换行分隔...',
      emailsIdentified: '已识别 {count} 个邮箱，需消耗 {cost} 积分。可用名额：{remaining}',
      redeemResult: '兑换结果',
      redeemSuccess: '成功',
      buttonLabel: '兑换 {count} 个名额（{cost} 积分）',
      buttonLabelNoEmail: '请输入邮箱',
      buttonLabelInsufficient: '积分不足',
      buttonLabelRedeeming: '兑换中...',
    },

    // Invite Unlock
    inviteUnlock: {
      title: '开通邀请权限',
      desc: '仅可兑换一次 · {cost} 积分',
      hint: '开通后可在「用户信息」页面查看邀请数据并生成邀请链接。',
      buttonLabel: '立即兑换',
      buttonLabelInsufficient: '积分不足',
      buttonLabelRedeeming: '兑换中...',
    },

    // Withdraw
    withdraw: {
      title: '提现',
      desc: '提交申请后人工处理',
      pointsLabel: '提现积分',
      pointsPlaceholder: '例如：10',
      rateHint: '返现规则：{points} 积分 = {cash} 元，预计返现 {amount} 元',
      methodLabel: '收款方式',
      alipay: '支付宝',
      wechat: '微信',
      accountLabel: '收款账号',
      accountPlaceholder: '支付宝账号 / 微信号',
      submitButton: '提交提现申请',
      submitting: '提交中...',
      notOpen: '未开放',
      recentWithdrawals: '最近提现',
      noWithdrawals: '暂无提现记录',
      pointsUnit: '积分',
      cashback: '返现 {amount} 元',
      errors: {
        notOpen: '提现功能暂未开放',
        invalidPoints: '请输入有效的提现积分',
        minPoints: '最低提现 {min} 积分',
        stepPoints: '提现积分需为 {step} 的倍数',
        maxPoints: '单次最多提现 {max} 积分',
        insufficientPoints: '积分不足，无法提现',
        noAccount: '请输入收款账号',
      },
      success: '提现申请已提交',
    },

    // Ledger
    ledger: {
      title: '积分变更明细',
      pageNumber: '第 {page} 页',
      time: '时间',
      change: '变更',
      balance: '余额',
      description: '说明',
      noRecords: '暂无积分变更记录',
      actions: {
        inviteReward: '邀请奖励',
        buyerReward: '购买奖励',
        inviteUnlock: '开通邀请权限',
        teamSeat: '兑换 ChatGPT Team 名额',
        withdraw: '提现申请',
        default: '积分变更',
      },
    },
  },

  // My Orders
  myOrders: {
    title: '我的订单',
    refreshList: '刷新列表',

    // Stats
    stats: {
      totalOrders: '总订单',
      paid: '已支付',
      pending: '待支付',
      refunded: '已退款',
      unit: '笔',
    },

    // Bind Order
    bindOrder: {
      title: '关联订单',
      desc: '输入订单号，将历史订单绑定到当前账号后即可在此查看。',
      placeholder: '请输入订单号',
      button: '关联订单',
    },

    // Order List
    orderList: {
      title: '订单列表',
      orderNo: '订单号',
      product: '商品',
      amount: '金额',
      status: '状态',
      createdAt: '创建时间',
      actions: '操作',
      pay: '去付款',
      noOrders: '暂无已关联订单',
    },

    // Redemption Records
    redemption: {
      title: '积分兑换记录',
      summary: '共 {count} 笔，消耗 {points} 积分',
      type: '兑换类型',
      email: '接收邮箱',
      account: '所属账号',
      points: '消耗积分',
      time: '兑换时间',
      noRecords: '暂无积分兑换记录',
    },

    // Status
    status: {
      paid: '已支付',
      refunded: '已退款',
      expired: '已过期',
      failed: '失败',
      pendingPayment: '待支付',
      created: '已创建',
    },
  },

  // User Info
  userInfo: {
    title: '用户信息',

    // Account Section
    account: {
      title: '账号信息',
      desc: '您的账号详情',
      username: '用户名',
      usernamePlaceholder: '输入用户名',
      updateUsername: '更新用户名',
      updating: '更新中...',
      email: '邮箱',
    },

    // Password Section
    password: {
      title: '修改密码',
      desc: '更新您的账号密码',
      current: '当前密码',
      currentPlaceholder: '输入当前密码',
      new: '新密码',
      newPlaceholder: '输入新密码（至少6位）',
      confirm: '确认密码',
      confirmPlaceholder: '确认新密码',
      update: '更新密码',
      updating: '更新中...',
    },

    // Invite Section
    invite: {
      title: '邀请推广',
      desc: '邀请他人获取积分奖励',
      notEnabled: '邀请功能未开通',
      enableHint: '在积分兑换页面开通邀请功能后，即可生成邀请链接。',
      goToExchange: '去积分兑换',
      inviteCode: '邀请码',
      inviteLink: '邀请链接',
      generateCode: '生成邀请码',
      generating: '生成中...',
      copyCode: '复制邀请码',
      copyLink: '复制链接',
      codeCopied: '邀请码已复制',
      linkCopied: '邀请链接已复制',
      stats: {
        points: '积分',
        invited: '已邀请',
        people: '人',
      },
    },

    // Orders Summary
    orders: {
      title: '订单概览',
      desc: '您的订单统计',
      total: '总订单',
      paid: '已支付',
      pending: '待支付',
      refunded: '已退款',
      viewAll: '查看全部订单',
    },
  },

  // Errors
  errors: {
    loadFailed: '加载失败',
    saveFailed: '保存失败',
    networkError: '网络错误',
    unauthorized: '未授权',
    forbidden: '禁止访问',
    notFound: '未找到',
    serverError: '服务器错误',
    insufficientPoints: '积分不足（需要 {required} 积分）',
    noAvailableSeats: '无可用名额',
    invalidEmail: '请输入有效的邮箱地址',
    requiredField: '此字段为必填',
    passwordTooShort: '密码至少需要 6 个字符',
    passwordMismatch: '两次输入的密码不一致',
  },
}
