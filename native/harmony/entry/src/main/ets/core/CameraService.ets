import { camera } from '@kit.CameraKit';
import { image } from '@kit.ImageKit';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { Journal } from './Journal';
import { Identity, Receipt, Shot, Stage, fresh } from './Protocol';

export class CameraService {
  private input?: camera.CameraInput;
  private preview?: camera.PreviewOutput;
  private photo?: camera.PhotoOutput;
  private session?: camera.PhotoSession;
  private pending?: Shot;
  private volatileShot?: Shot;
  private volatileBytes?: ArrayBuffer;
  get hasUnstored(): boolean { return this.volatileBytes!==undefined; }
  capturing: boolean=false;
  width: number=4000;
  height: number=3000;
  constructor(private context: common.UIAbilityContext, private journal: Journal, private saved: ()=>void, private failed: (text: string)=>void) {}
  async open(surface: string, degree: number): Promise<void> {
    const manager=camera.getCameraManager(this.context);
    const device=manager.getSupportedCameras().find((c: camera.CameraDevice)=>c.cameraPosition===camera.CameraPosition.CAMERA_POSITION_BACK);
    if(!device) throw new Error('无可用后置摄像头');
    const caps=manager.getSupportedOutputCapability(device,camera.SceneMode.NORMAL_PHOTO);
    const photos=caps.photoProfiles.filter((p: camera.Profile)=>p.format===camera.CameraFormat.CAMERA_FORMAT_JPEG)
      .sort((a: camera.Profile,b: camera.Profile)=>b.size.width*b.size.height-a.size.width*a.size.height);
    const profile=photos[0]; if(!profile) throw new Error('设备未提供JPEG静态拍照');
    const preview=caps.previewProfiles.slice().sort((a: camera.Profile,b: camera.Profile)=>Math.abs(a.size.width/a.size.height-profile.size.width/profile.size.height)-Math.abs(b.size.width/b.size.height-profile.size.width/profile.size.height))[0];
    if(!preview) throw new Error('无匹配取景配置');
    this.width=profile.size.width; this.height=profile.size.height;
    this.input=manager.createCameraInput(device); await this.input.open();
    this.preview=manager.createPreviewOutput(preview,surface); this.photo=manager.createPhotoOutput(profile);
    this.photo.on('photoAvailable',async (error: BusinessError, photo: camera.Photo)=>{
      const shot=this.pending;
      if(error || !shot) {
        if(shot) { shot.stage=Stage.Failed; shot.error='照片捕获失败；已存在的文件仍保留'; this.journal.persist(shot); }
        if(photo) await photo.release(); this.pending=undefined; this.capturing=false; this.failed('照片捕获失败；已存在的文件仍保留'); return;
      }
      let buffer: ArrayBuffer | undefined;
      try {
        const component=await photo.main.getComponent(image.ComponentType.JPEG);
        buffer=component.byteBuffer;
        await this.journal.bytesAsync(shot.raw,component.byteBuffer); shot.stage=Stage.Captured; this.journal.persist(shot); this.saved();
      } catch(e) {
        if(buffer) { this.volatileBytes=buffer.slice(0); this.volatileShot=shot; }
        shot.stage=Stage.Failed; shot.error=buffer?'暂存失败，完整JPEG保留在当前会话内，请勿退出；释放空间后重试暂存':`捕获未完成：${e}`;
        try { this.journal.persist(shot); } catch { }
        this.failed(shot.error);
      }
      finally { await photo.release(); this.pending=undefined; this.capturing=false; }
    });
    this.session=manager.createSession<camera.PhotoSession>(camera.SceneMode.NORMAL_PHOTO);
    this.session.beginConfig(); this.session.addInput(this.input); this.session.addOutput(this.preview); this.session.addOutput(this.photo);
    await this.session.commitConfig(); this.rotate(degree); await this.session.start();
  }
  rotate(degree: number): number {
    if(this.preview) this.preview.setPreviewRotation(this.preview.getPreviewRotation(degree),false);
    const rotation=this.photo ? this.photo.getPhotoRotation(degree) : camera.ImageRotation.ROTATION_90;
    return rotation%180===0 ? this.width/this.height : this.height/this.width;
  }
  async capture(actor: Identity, receipt: Receipt, degree: number): Promise<void> {
    if(!this.photo || this.capturing || this.hasUnstored) throw new Error('相机尚未就绪、正在捕获或有未暂存照片');
    if(!fresh(receipt)) throw new Error('地点凭据过期，请更新位置');
    const shot=this.journal.create(actor,receipt); this.pending=shot; this.capturing=true;
    try { await this.photo.capture({quality:camera.QualityLevel.QUALITY_LEVEL_HIGH,rotation:this.photo.getPhotoRotation(degree)}); }
    catch(e) { shot.stage=Stage.Failed; shot.error=`相机失败：${e}`; this.journal.persist(shot); this.pending=undefined; this.capturing=false; throw new Error(shot.error); }
  }
  async close(): Promise<void> {
    if(this.hasUnstored) throw new Error('尚有仅在内存的照片，请先重试暂存，不要退出');
    if(this.capturing) throw new Error('照片正在捕获，请稍候');
    if(this.session) { await this.session.stop(); await this.session.release(); }
    if(this.preview) await this.preview.release(); if(this.photo) await this.photo.release(); if(this.input) await this.input.close();
    this.session=undefined; this.preview=undefined; this.photo=undefined; this.input=undefined;
  }
  retryPrivate(): void {
    const shot=this.volatileShot; const buffer=this.volatileBytes;
    if(!shot || !buffer) return;
    this.journal.bytes(shot.raw,buffer); shot.stage=Stage.Captured; shot.error=''; this.journal.persist(shot);
    this.volatileShot=undefined; this.volatileBytes=undefined; this.saved();
  }
}
