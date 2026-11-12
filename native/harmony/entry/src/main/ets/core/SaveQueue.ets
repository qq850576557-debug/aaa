import { common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { Journal } from './Journal';
import { Watermark } from './Watermark';
import { Album } from './Album';
import { Stage, Shot } from './Protocol';

export class SaveQueue {
  busy: boolean=false;
  needsConsent: boolean=false;
  album: Album;
  renderer: Watermark;
  constructor(context: common.UIAbilityContext, public journal: Journal) {
    this.album=new Album(context,journal); this.renderer=new Watermark(context,journal);
    for(const shot of journal.all()) {
      if(shot.stage===Stage.Capturing) { shot.stage=fs.accessSync(shot.raw)&&fs.statSync(shot.raw).size>0?Stage.Captured:Stage.Failed; shot.error=shot.stage===Stage.Failed?'上次捕获中断，没有完整照片，请保留任务并重新拍摄':''; journal.persist(shot); }
    }
  }
  async prepareForConsent(): Promise<void> {
    // Finish the serial watermark queue before opening ONE batch consent dialog.
    while(this.busy) await new Promise<void>((resolve)=>{setTimeout(resolve,40);});
    await this.drain(false,true);
  }
  async confirmedBatch(shots: Shot[]): Promise<void> {
    while(this.busy) await new Promise<void>((resolve)=>{setTimeout(resolve,40);});
    this.busy=true;
    try {
      // A live OS dialog is not an interrupted create. Keep tick/drain out,
      // and re-read current stages so a second click cannot recreate saved assets.
      const ids=shots.map((s: Shot)=>s.id);
      await this.album.confirmedBatch(this.journal.all().filter((s: Shot)=>ids.includes(s.id) && s.stage===Stage.Marked));
    } finally { this.busy=false; }
  }
  async drain(automatic: boolean, retry: boolean=false): Promise<void> {
    if(this.busy) return;
    this.busy=true;
    try {
      for(const shot of this.journal.all()) {
        if(shot.stage===Stage.Saved || shot.stage===Stage.Unknown || (shot.stage===Stage.Failed && !retry) || (shot.stage===Stage.Marked && shot.error.length>0 && !retry)) continue;
        if(shot.stage===Stage.Creating && !shot.mediaUri) { shot.stage=Stage.Unknown; shot.error='创建相册项目期间中断，请核查，禁止重复创建'; this.journal.persist(shot); continue; }
        if(shot.stage===Stage.Capturing) continue; // Never process an image still owned by the camera callback.
        try {
          if(!fs.accessSync(shot.output)) {
            // Validate capture-time lease, never reinterpret an old GPS fix as a new one.
            const captured=Date.parse(shot.capturedAt); const obtained=Date.parse(shot.receipt.location.obtainedAt);
            if(captured<obtained-5000 || captured>obtained+90000 || captured>Date.parse(shot.receipt.expiresAt)) throw new Error('拍摄时定位已过期，原文件保留');
            await this.renderer.render(shot);
          }
          if(shot.mediaUri || automatic) await this.album.direct(shot);
        } catch(e) {
          if(shot.stage!==Stage.Unknown && shot.stage!==Stage.Marked) shot.stage=Stage.Failed;
          if(shot.stage===Stage.Marked) this.needsConsent=true;
          shot.error=`${e}`; this.journal.persist(shot);
        }
      }
    } finally { this.busy=false; }
  }
}
