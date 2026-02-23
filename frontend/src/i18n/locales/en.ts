export default {
  // Common
  common: {
    loading: 'Loading...',
    refresh: 'Refresh',
    submit: 'Submit',
    cancel: 'Cancel',
    save: 'Save',
    delete: 'Delete',
    edit: 'Edit',
    copy: 'Copy',
    copied: 'Copied',
    copyFailed: 'Copy failed, please copy manually',
    success: 'Success',
    failed: 'Failed',
    error: 'Error',
    confirm: 'Confirm',
    back: 'Back',
    next: 'Next',
    previous: 'Previous',
    page: 'Page',
    total: 'Total',
    noData: 'No data',
    unknown: 'Unknown',
  },

  // Points Exchange
  pointsExchange: {
    title: 'Points Exchange',
    tabs: {
      exchange: 'Exchange',
      ledger: 'History',
    },
    availablePoints: 'Available Points',
    availablePointsDesc: 'Redeem seats or submit withdrawal requests (invitations will be sent to the email provided).',
    currentPoints: 'Current Points',

    // Team Seat
    teamSeat: {
      title: 'Redeem ChatGPT Team Seat',
      desc: '30 days · {cost} points/seat · Batch supported',
      emailLabel: 'Recipient Email',
      emailPlaceholder: 'Enter email addresses, separate multiple emails with commas or newlines...',
      emailsIdentified: '{count} email(s) identified, {cost} points required. Available seats: {remaining}',
      redeemResult: 'Redemption Result',
      redeemSuccess: 'Success',
      buttonLabel: 'Redeem {count} seat(s) ({cost} points)',
      buttonLabelNoEmail: 'Please enter email',
      buttonLabelInsufficient: 'Insufficient points',
      buttonLabelRedeeming: 'Redeeming...',
    },

    // Invite Unlock
    inviteUnlock: {
      title: 'Unlock Invite Permission',
      desc: 'One-time redemption · {cost} points',
      hint: 'After unlocking, you can view invite data and generate invite links on the "User Info" page.',
      buttonLabel: 'Redeem Now',
      buttonLabelInsufficient: 'Insufficient points',
      buttonLabelRedeeming: 'Redeeming...',
    },

    // Withdraw
    withdraw: {
      title: 'Withdraw',
      desc: 'Manual processing after submission',
      pointsLabel: 'Withdraw Points',
      pointsPlaceholder: 'e.g., 10',
      rateHint: 'Rate: {points} points = ¥{cash}, estimated: ¥{amount}',
      methodLabel: 'Payment Method',
      alipay: 'Alipay',
      wechat: 'WeChat',
      accountLabel: 'Account',
      accountPlaceholder: 'Alipay account / WeChat ID',
      submitButton: 'Submit Withdrawal',
      submitting: 'Submitting...',
      notOpen: 'Not Available',
      recentWithdrawals: 'Recent Withdrawals',
      noWithdrawals: 'No withdrawal records',
      pointsUnit: 'points',
      cashback: 'Cashback ¥{amount}',      errors: {
        notOpen: 'Withdrawal is not available',
        invalidPoints: 'Please enter valid withdrawal points',
        minPoints: 'Minimum withdrawal is {min} points',
        stepPoints: 'Withdrawal points must be a multiple of {step}',
        maxPoints: 'Maximum withdrawal is {max} points per request',
        insufficientPoints: 'Insufficient points for withdrawal',
        noAccount: 'Please enter your payout account',
      },
      success: 'Withdrawal request submitted',      errors: {
        notOpen: 'Withdrawal is not available',
        invalidPoints: 'Please enter valid points',
        minPoints: 'Minimum withdrawal: {min} points',
        stepPoints: 'Points must be a multiple of {step}',
        maxPoints: 'Maximum withdrawal per request: {max} points',
        insufficientPoints: 'Insufficient points for withdrawal',
        noAccount: 'Please enter payment account',
      },
      success: 'Withdrawal request submitted',
    },

    // Ledger
    ledger: {
      title: 'Points History',
      pageNumber: 'Page {page}',
      time: 'Time',
      change: 'Change',
      balance: 'Balance',
      description: 'Description',
      noRecords: 'No records',
      actions: {
        inviteReward: 'Invite Reward',
        buyerReward: 'Purchase Reward',
        inviteUnlock: 'Unlock Invite Permission',
        teamSeat: 'Redeem ChatGPT Team Seat',
        withdraw: 'Withdrawal Request',
        default: 'Points Change',
      },
    },
  },

  // My Orders
  myOrders: {
    title: 'My Orders',
    refreshList: 'Refresh List',

    // Stats
    stats: {
      totalOrders: 'Total Orders',
      paid: 'Paid',
      pending: 'Pending',
      refunded: 'Refunded',
      unit: 'orders',
    },

    // Bind Order
    bindOrder: {
      title: 'Link Order',
      desc: 'Enter order number to link historical orders to your account.',
      placeholder: 'Enter order number',
      button: 'Link Order',
    },

    // Order List
    orderList: {
      title: 'Order List',
      orderNo: 'Order No.',
      product: 'Product',
      amount: 'Amount',
      status: 'Status',
      createdAt: 'Created',
      actions: 'Actions',
      pay: 'Pay',
      noOrders: 'No linked orders',
    },

    // Redemption Records
    redemption: {
      title: 'Points Redemption Records',
      summary: '{count} records, {points} points consumed',
      type: 'Type',
      email: 'Email',
      account: 'Account',
      points: 'Points',
      time: 'Time',
      noRecords: 'No redemption records',
    },

    // Status
    status: {
      paid: 'Paid',
      refunded: 'Refunded',
      expired: 'Expired',
      failed: 'Failed',
      pendingPayment: 'Pending Payment',
      created: 'Created',
    },
  },

  // User Info
  userInfo: {
    title: 'User Info',

    // Account Section
    account: {
      title: 'Account Information',
      desc: 'Your account details',
      username: 'Username',
      usernamePlaceholder: 'Enter username',
      updateUsername: 'Update Username',
      updating: 'Updating...',
      email: 'Email',
    },

    // Password Section
    password: {
      title: 'Change Password',
      desc: 'Update your account password',
      current: 'Current Password',
      currentPlaceholder: 'Enter current password',
      new: 'New Password',
      newPlaceholder: 'Enter new password (min 6 characters)',
      confirm: 'Confirm Password',
      confirmPlaceholder: 'Confirm new password',
      update: 'Update Password',
      updating: 'Updating...',
    },

    // Invite Section
    invite: {
      title: 'Invite & Referral',
      desc: 'Earn points by inviting others',
      notEnabled: 'Invite feature not enabled',
      enableHint: 'Enable invite feature in Points Exchange to generate referral links.',
      goToExchange: 'Go to Points Exchange',
      inviteCode: 'Invite Code',
      inviteLink: 'Invite Link',
      generateCode: 'Generate Invite Code',
      generating: 'Generating...',
      copyCode: 'Copy Code',
      copyLink: 'Copy Link',
      codeCopied: 'Invite code copied',
      linkCopied: 'Invite link copied',
      stats: {
        points: 'Points',
        invited: 'Invited',
        people: 'people',
      },
    },

    // Orders Summary
    orders: {
      title: 'Orders Summary',
      desc: 'Your order statistics',
      total: 'Total Orders',
      paid: 'Paid',
      pending: 'Pending',
      refunded: 'Refunded',
      viewAll: 'View All Orders',
    },
  },

  // Errors
  errors: {
    loadFailed: 'Load failed',
    saveFailed: 'Save failed',
    networkError: 'Network error',
    unauthorized: 'Unauthorized',
    forbidden: 'Forbidden',
    notFound: 'Not found',
    serverError: 'Server error',
    insufficientPoints: 'Insufficient points (need {required} points)',
    noAvailableSeats: 'No available seats',
    invalidEmail: 'Please enter a valid email address',
    requiredField: 'This field is required',
    passwordTooShort: 'Password must be at least 6 characters',
    passwordMismatch: 'Passwords do not match',
  },
}
