const avatar = require('./avatar');

function avatarEditor(personKey, savePath) {
  return {
    avatarEpoch: 0,
    cropSession: null,
    dragOrigin: null,
    releaseAvatar() {
      this.avatarEpoch++;
      this.cropSession = null;
      this.dragOrigin = null;
      if (this.data.privacyVisible) this.rejectAvatarPrivacy();
    },
    async chooseAvatar() {
      if (!this.data[personKey] || this.data.avatarLoading || this.data.cropOpen) return;
      const epoch = ++this.avatarEpoch;
      this.setData({ avatarLoading: true });
      try {
        const path = await avatar.choosePhoto();
        if (!path || epoch !== this.avatarEpoch) return;
        await new Promise((render) =>
          this.setData({ cropOpen: true, cropReady: false }, () => render(undefined)),
        );
        if (epoch !== this.avatarEpoch) return;
        const { canvas, frame } = await avatar.canvasForPreview();
        if (epoch !== this.avatarEpoch) return;
        const image = await avatar.loadImage(canvas, path);
        if (epoch !== this.avatarEpoch) return;
        this.cropSession = {
          canvas,
          frame,
          image,
          crop: avatar.cropBox(image.width, image.height),
        };
        avatar.paint(canvas, image, this.cropSession.crop);
        this.setData({ cropReady: true });
      } catch (error) {
        if (epoch !== this.avatarEpoch) return;
        this.resetCrop();
        const message = error?.errMsg || error?.message || '';
        if (!/cancel/i.test(message)) {
          const title = /privacy|permission|auth deny/i.test(message)
            ? '请授权相册访问后重试'
            : '无法打开照片，请换一张重试';
          wx.showToast({ title, icon: 'none' });
        }
      } finally {
        if (epoch === this.avatarEpoch) this.setData({ avatarLoading: false });
      }
    },
    gestureStart(event) {
      const point = event.touches[0];
      if (!this.cropSession || !point || this.data.savingAvatar) return;
      this.dragOrigin = { x: point.pageX, y: point.pageY, crop: this.cropSession.crop };
    },
    gestureMove(event) {
      const point = event.touches[0];
      if (!this.dragOrigin || !point || !this.cropSession || this.data.savingAvatar) return;
      const { x, y, crop } = this.dragOrigin;
      const ratio = crop.size / this.cropSession.frame;
      this.positionCrop(
        crop.zoom,
        crop.x + crop.size / 2 - (point.pageX - x) * ratio,
        crop.y + crop.size / 2 - (point.pageY - y) * ratio,
      );
    },
    gestureEnd() {
      this.dragOrigin = null;
    },
    changeZoom(event) {
      const crop = this.cropSession?.crop;
      const zoom = Number(event.detail.value);
      if (!crop || this.data.savingAvatar || !Number.isFinite(zoom)) return;
      this.dragOrigin = null;
      this.positionCrop(
        Math.max(1, Math.min(avatar.MAX_ZOOM, zoom)),
        crop.x + crop.size / 2,
        crop.y + crop.size / 2,
      );
    },
    positionCrop(zoom, x, y) {
      const current = this.cropSession;
      current.crop = avatar.cropBox(current.image.width, current.image.height, zoom, x, y);
      avatar.paint(current.canvas, current.image, current.crop);
    },
    closeCrop() {
      if (!this.data.savingAvatar) this.resetCrop();
    },
    resetCrop() {
      this.avatarEpoch++;
      this.cropSession = null;
      this.dragOrigin = null;
      this.setData({
        cropOpen: false,
        cropReady: false,
        savingAvatar: false,
        avatarLoading: false,
      });
    },
    async saveAvatar() {
      if (!this.data.cropReady || !this.cropSession || this.data.savingAvatar) return;
      const epoch = this.avatarEpoch;
      this.setData({ savingAvatar: true });
      try {
        const path = await avatar.exportAvatar(this.cropSession.canvas);
        if (epoch !== this.avatarEpoch) return;
        await savePath.call(this, path);
        if (epoch !== this.avatarEpoch) return;
        this.resetCrop();
      } catch {
        if (epoch !== this.avatarEpoch) return;
        this.setData({ savingAvatar: false });
        wx.showToast({ title: '头像保存失败，请重试', icon: 'none' });
      }
    },
    openAvatarPrivacy() {
      wx.openPrivacyContract({
        fail: () => wx.showToast({ title: '隐私保护指引尚未配置', icon: 'none' }),
      });
    },
    agreeAvatarPrivacy() {
      getApp().resolvePrivacy(true);
    },
    rejectAvatarPrivacy() {
      getApp().resolvePrivacy(false);
    },
    stop() {},
  };
}

module.exports = { avatarEditor };
