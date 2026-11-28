const AVATAR_SIZE = 512;
const MAX_ZOOM = 3;

function cropBox(width, height, zoom = 1, centerX = width / 2, centerY = height / 2) {
  const size = Math.min(width, height) / zoom;
  const clamp = (center, length) => Math.max(0, Math.min(length - size, center - size / 2));
  return { x: clamp(centerX, width), y: clamp(centerY, height), size, zoom };
}

async function choosePhoto() {
  const result = await wx.chooseMedia({
    count: 1,
    mediaType: ['image'],
    sourceType: ['album'],
    sizeType: ['compressed'],
  });
  return result.tempFiles[0]?.tempFilePath;
}

function canvasForPreview(component) {
  return new Promise((resolve, reject) => {
    (component ? component.createSelectorQuery() : wx.createSelectorQuery())
      .select('#avatar-canvas')
      .fields({ node: true, size: true })
      .exec(([result]) => {
        if (!result?.node || !result.width) {
          reject(Error('当前微信版本无法打开头像裁切，请升级微信后重试。'));
          return;
        }
        const canvas = result.node;
        canvas.width = AVATAR_SIZE;
        canvas.height = AVATAR_SIZE;
        resolve({ canvas, frame: result.width });
      });
  });
}

/** @param {WechatMiniprogram.Canvas} canvas */
function loadImage(canvas, path) {
  return new Promise((resolve, reject) => {
    const image = canvas.createImage();
    image.onload = () => {
      if (image.width > 0 && image.height > 0) resolve(image);
      else reject(Error('无法读取这张照片的尺寸，请换一张。'));
    };
    image.onerror = () => reject(Error('无法读取这张照片，请换一张。'));
    image.src = path;
  });
}

/** @param {WechatMiniprogram.Canvas} canvas */
function paint(canvas, image, crop) {
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(image, crop.x, crop.y, crop.size, crop.size, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
}

/** @param {WechatMiniprogram.Canvas} canvas */
async function exportAvatar(canvas) {
  const { tempFilePath } = await wx.canvasToTempFilePath({
    canvas,
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    destWidth: AVATAR_SIZE,
    destHeight: AVATAR_SIZE,
    fileType: 'jpg',
    quality: 0.94,
  });
  const { width, height } = await wx.getImageInfo({ src: tempFilePath });
  if (width !== AVATAR_SIZE || height !== AVATAR_SIZE) throw Error('头像裁切未成功，请重试。');
  return tempFilePath;
}

module.exports = {
  MAX_ZOOM,
  cropBox,
  choosePhoto,
  canvasForPreview,
  loadImage,
  paint,
  exportAvatar,
};
