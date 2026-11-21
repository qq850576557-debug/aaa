const defaults = require('./ui-dev-tokens');

const overrides = {};
const limits = {
  logoTop: [30, 240],
  logoWidth: [24, 84],
  logoToBrandGap: [4, 40],
  brandToSloganGap: [4, 40],
  brandFontSize: [12, 28],
  sloganFontSize: [9, 18],
  sloganLetterSpacing: [0, 4, 0.1],
  loginButtonTop: [30, 230],
  headerTop: [36, 100],
  titleBottomGap: [4, 40],
  primaryCardHeight: [64, 160],
  secondaryCardGap: [4, 28],
  sectionTopGap: [10, 50],
  infoCardTop: [0, 40],
  infoCardPadding: [10, 28],
  avatarSize: [44, 84],
  avatarTextGap: [6, 30],
  footerTopGap: [8, 56],
  footerFontSize: [8, 16],
};

function isDevelop() {
  try {
    const version = wx.getAccountInfoSync?.()?.miniProgram?.envVersion;
    return version === 'develop' || (!version && wx.getDeviceInfo?.()?.platform === 'devtools');
  } catch {
    return wx.getDeviceInfo?.()?.platform === 'devtools';
  }
}

function style(tokens) {
  const rules = Object.entries(tokens)
    .filter(([, value]) => typeof value === 'number')
    .map(
      ([key, value]) =>
        '--ui-' +
        key.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase()) +
        ':' +
        value +
        'px;',
    );
  if ('logoWidth' in tokens) rules.push('--ui-logo-height:' + (tokens.logoWidth * 46) / 43 + 'px;');
  if ('brandFontSize' in tokens)
    rules.push('--ui-brand-width:' + (tokens.brandFontSize * 104) / 17 + 'px;');
  if ('footerFontSize' in tokens)
    rules.push('--ui-footer-wordmark:' + (tokens.footerFontSize * 104) / 17 + 'px;');
  return rules.join('');
}

function apply(page, group) {
  const enabled = isDevelop();
  const tokens = { ...defaults[group], ...(enabled ? overrides[group] : {}) };
  page.setData({
    ui: tokens,
    uiStyle: style(tokens),
    uiDev: enabled,
    ...(enabled
      ? {
          uiFields: Object.entries(tokens).map(([key, value]) => ({
            key,
            value,
            type: typeof value,
            min: limits[key]?.[0],
            max: limits[key]?.[1],
            step: limits[key]?.[2] ?? 1,
          })),
        }
      : {}),
  });
}

function withUi(group, page) {
  return {
    ...page,
    data: {
      ...page.data,
      ui: defaults[group],
      uiStyle: style(defaults[group]),
      uiDev: false,
      uiOpen: false,
      uiFields: [],
    },
    onLoad(options) {
      page.onLoad?.call(this, options);
      if (this.data.ready) apply(this, group);
    },
    onShow() {
      page.onShow?.call(this);
      if (this.data.ready) apply(this, group);
    },
    toggleUi() {
      if (this.data.uiDev) this.setData({ uiOpen: !this.data.uiOpen });
    },
    changeUi(event) {
      if (!this.data.uiDev) return;
      const { key } = event.currentTarget.dataset;
      if (!Object.prototype.hasOwnProperty.call(defaults[group], key)) return;
      let { value } = event.detail;
      if (limits[key]) {
        value = Number(value);
        if (!Number.isFinite(value)) return;
        const [min, max, step = 1] = limits[key];
        value = Number(Math.min(max, Math.max(min, Math.round(value / step) * step)).toFixed(1));
      } else if (key === 'footerVisible') value = value === true;
      else value = String(value).slice(0, 40);
      overrides[group] = { ...overrides[group], [key]: value };
      apply(this, group);
    },
    resetUi() {
      if (!this.data.uiDev) return;
      delete overrides[group];
      apply(this, group);
    },
    copyUi() {
      if (!this.data.uiDev) return;
      const config = Object.fromEntries(
        Object.entries(defaults).map(([name, values]) => [name, { ...values, ...overrides[name] }]),
      );
      wx.setClipboardData({ data: JSON.stringify(config, null, 2) });
    },
  };
}

module.exports = { withUi };
