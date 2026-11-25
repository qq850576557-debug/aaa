const ownerSession = require('./owner-session');

function startPreview(page, ready = true) {
  const version = wx.getAccountInfoSync?.().miniProgram?.envVersion;
  if (
    ownerSession.productionBuild()
      ? !ownerSession.availableBuild()
      : version !== 'develop' && version !== 'trial'
  ) {
    wx.reLaunch({ url: '/pages/login/index?manual=1' });
    return;
  }
  const statusTop = wx.getWindowInfo?.().statusBarHeight ?? 24;
  page.setData({ ready, statusTop });
  return true;
}

const routes = {
  welcome: '/owner-login/pages/welcome/index',
  home: '/owner-login/pages/home/index',
  purchases: '/owner-login/pages/purchases/index',
  purchase: '/owner-login/pages/purchase/index',
  profile: '/owner-login/pages/profile/index',
};

function go(page, query = '') {
  wx.navigateTo({ url: routes[page] + query });
}

function back(fallback = 'home') {
  wx.navigateBack({ fail: () => wx.reLaunch({ url: routes[fallback] }) });
}

function showPolicy(event) {
  if (ownerSession.productionBuild()) {
    if (event.currentTarget.dataset.title === '隐私保护指引') {
      const unavailable = () => wx.showToast({ title: '暂时无法打开隐私保护指引', icon: 'none' });
      if (typeof wx.openPrivacyContract === 'function')
        wx.openPrivacyContract({ fail: unavailable });
      else unavailable();
    } else if (ownerSession.terms()) {
      wx.navigateTo({ url: '/owner-login/pages/terms/index' });
    } else {
      wx.showToast({ title: '正式用户协议待确认', icon: 'none' });
    }
    return;
  }
  wx.showModal({
    title: event.currentTarget.dataset.title,
    content: '正式内容将在春茉确认后提供。',
    showCancel: false,
  });
}

module.exports = { startPreview, routes, go, back, showPolicy };
