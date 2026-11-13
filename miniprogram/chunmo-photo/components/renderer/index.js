const { call } = require('../../lib/platform');
const { drawWatermark, neutralizeExif, orientationTransform } = require('../../lib/watermark');
const { record } = require('../../lib/metrics');
const orientations = {
  up: 1,
  'up-mirrored': 2,
  down: 3,
  'down-mirrored': 4,
  'left-mirrored': 5,
  right: 6,
  'right-mirrored': 7,
  left: 8,
};
/** @type {WechatMiniprogram.Component.Options<{}, {}, WechatMiniprogram.Component.MethodOption, [], {initialization: Promise<void>, resolveInitialization: Function, rejectInitialization: Function, canvas: WechatMiniprogram.Canvas, logo: WechatMiniprogram.Image, busy: boolean, closed: boolean}>} */
const definition = {
  lifetimes: {
    attached() {
      this.initialization = new Promise((resolve, reject) => {
        this.resolveInitialization = resolve;
        this.rejectInitialization = reject;
      });
      this.initialization.catch(() => {});
    },
    ready() {
      this.createSelectorQuery()
        .select('#fullPhoto')
        .fields({ node: true, size: true })
        .exec((result) => {
          if (!result[0] || !result[0].node)
            return this.rejectInitialization(Error('此微信版本不支持高清Canvas，请升级微信'));
          this.canvas = result[0].node;
          this.loadImage('/assets/chunmo-original.jpg').then((logo) => {
            this.logo = logo;
            this.resolveInitialization();
          }, this.rejectInitialization);
        });
    },
    detached() {
      this.closed = true;
      if (!this.busy && this.canvas) this.canvas.width = this.canvas.height = 1;
    },
  },
  methods: {
    loadImage(path) {
      return new Promise((resolve, reject) => {
        const image = this.canvas.createImage();
        image.onload = () => resolve(image);
        image.onerror = () => reject(Error('照片解码失败，原图已保留'));
        image.src = path;
      });
    },
    async render(task) {
      await this.initialization;
      if (this.closed) throw Error('拍摄页面已关闭，原图已保留，可在结果页重试');
      const started = Date.now(),
        fs = wx.getFileSystemManager();
      const io = (name, args) =>
        new Promise((resolve, reject) => fs[name]({ ...args, success: resolve, fail: reject }));
      const raw = task.dir + '/raw',
        canvas = this.canvas;
      let image;
      this.busy = true;
      try {
        const info = await call('getImageInfo', { src: raw });
        record('source-pixels', started, { width: info.width, height: info.height });
        if (
          !info.width ||
          !info.height ||
          info.width * info.height > 24000000 ||
          Math.max(info.width, info.height) > 8192
        )
          throw Error('照片超过24MP或8192边长的安全合成范围；原图已保留，未缩小照片');
        const stat = await io('stat', { path: raw });
        const header = await io('readFile', {
          filePath: raw,
          position: 0,
          length: Math.min(stat.stats.size, 256 * 1024),
        });
        const parsed = neutralizeExif(header.data);
        const orientation = orientations[info.orientation] || 1;
        let source = raw;
        if (parsed.jpeg) {
          const tail = new Uint8Array(
            (await io('readFile', { filePath: raw, position: stat.stats.size - 2, length: 2 }))
              .data,
          );
          if (tail[0] !== 0xff || tail[1] !== 0xd9) throw Error('照片尚不完整，原图已保留');
        }
        if (orientation !== 1 || parsed.orientation !== 1) {
          if (!parsed.jpeg || parsed.orientation !== orientation)
            throw Error('此照片方向暂不能安全合成，原图已保留，请联系负责人');
          source = task.dir + '/decode.jpg';
          await io('copyFile', { srcPath: raw, destPath: source });
          const { fd } = await io('open', { filePath: source, flag: 'r+' });
          try {
            await io('write', { fd, data: header.data, position: 0 });
          } finally {
            await io('close', { fd });
          }
        }
        image = await this.loadImage(source);
        const rotated = orientation >= 5;
        const width = rotated ? info.height : info.width,
          height = rotated ? info.width : info.height;
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        const matrix = orientationTransform(orientation, info.width, info.height);
        ctx.save();
        ctx.transform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
        ctx.drawImage(image, 0, 0, info.width, info.height);
        ctx.restore();
        drawWatermark(ctx, this.logo, width, height, task);
        record('watermark-draw', started, { width, height });
        const encodeStart = Date.now();
        const output = await call('canvasToTempFilePath', {
          canvas,
          x: 0,
          y: 0,
          width,
          height,
          destWidth: width,
          destHeight: height,
          fileType: 'jpg',
          quality: 1,
        });
        // Decode dimensions only, not another full JS bitmap. Export must match
        // exactly, otherwise keep the raw and refuse a silently downscaled result.
        const actual = await call('getImageInfo', { src: output.tempFilePath });
        if (actual.width !== width || actual.height !== height)
          throw Error('设备未能输出原像素水印图，原图已保留');
        record('photo-encode', encodeStart, { width, height });
        let thumbnail;
        try {
          const f = Math.min(1, 240 / Math.max(width, height));
          thumbnail = (
            await call('canvasToTempFilePath', {
              canvas,
              width,
              height,
              destWidth: Math.round(width * f),
              destHeight: Math.round(height * f),
              fileType: 'jpg',
              quality: 0.72,
            })
          ).tempFilePath;
        } catch {
          /* Use text placeholder; never decode all full-size files for a grid. */
        }
        return {
          path: output.tempFilePath,
          thumbnail,
          width,
          height,
          rawWidth: info.width,
          rawHeight: info.height,
        };
      } finally {
        image = null;
        canvas.width = canvas.height = 1;
        this.busy = false;
        // Only our derivable decode copy is removed. raw/marked files stay intact.
        try {
          await io('unlink', { filePath: task.dir + '/decode.jpg' });
        } catch {
          /* optional */
        }
      }
    },
  },
};
Component(definition);
