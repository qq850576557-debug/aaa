const { routes } = require('../../preview');

Component({
  properties: { active: { type: String, value: 'home' } },
  methods: {
    switchTab(event) {
      const tab = event.currentTarget.dataset.tab;
      if (!['home', 'profile'].includes(tab) || tab === this.data.active || this.opening) return;
      this.opening = true;
      const complete = () => {
        this.opening = false;
      };
      if (tab === 'profile') {
        wx.navigateTo({ url: routes.profile, complete });
        return;
      }
      const previous = getCurrentPages().at(-2);
      if (previous?.route === routes.home.slice(1)) wx.navigateBack({ complete });
      else wx.redirectTo({ url: routes.home, complete });
    },
  },
});
