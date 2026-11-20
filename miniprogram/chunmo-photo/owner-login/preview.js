function startPreview(page, ready = true) {
  const version = wx.getAccountInfoSync?.().miniProgram?.envVersion;
  if (version !== 'develop' && version !== 'trial') {
    wx.reLaunch({ url: '/pages/login/index' });
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
  wx.showModal({
    title: event.currentTarget.dataset.title,
    content: '正式内容将在春茉确认后提供。',
    showCancel: false,
  });
}

module.exports = { startPreview, routes, go, back, showPolicy };
