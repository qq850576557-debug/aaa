Component({
  properties: { active: { type: String, value: 'home' } },
  methods: {
    switchTab(event) {
      const tab = event.currentTarget.dataset.tab;
      if (['home', 'profile'].includes(tab) && tab !== this.data.active)
        this.triggerEvent('change', { tab });
    },
  },
});
