import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { common } from '@kit.AbilityKit';
import { fileIo as fs, fileUri } from '@kit.CoreFileKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { Journal } from './Journal';
import { Shot, Stage } from './Protocol';

async function hash(path: string): Promise<string> {
  const f=fs.openSync(path,fs.OpenMode.READ_ONLY); const md=cryptoFramework.createMd('SHA256');
  try {
    const size=fs.statSync(f.fd).size; let at=0;
    while(at<size) { const buffer=new ArrayBuffer(Math.min(65536,size-at)); const n=fs.readSync(f.fd,buffer,{offset:at});
      if(n<=0) throw new Error('文件读取不完整'); await md.update({data:new Uint8Array(buffer,0,n)}); at+=n; }
    const result=await md.digest(); let value=''; result.data.forEach((n: number)=>{ value+=n.toString(16).padStart(2,'0'); }); return value;
  } finally { fs.closeSync(f); }
}
export class Album {
  constructor(private context: common.UIAbilityContext, private journal: Journal) {}
  async direct(shot: Shot): Promise<void> {
    if(shot.stage===Stage.Unknown || (shot.stage===Stage.Creating && !shot.mediaUri)) throw new Error('上次创建相册项目的回执不明确，禁止重复创建，请核查原相册项目');
    if(!shot.mediaUri) {
      shot.stage=Stage.Creating; this.journal.persist(shot);
      try { shot.mediaUri=await photoAccessHelper.getPhotoAccessHelper(this.context).createAsset(photoAccessHelper.PhotoType.IMAGE,'jpg',{title:'CHUNMO_'+shot.id}); }
      catch(e) {
        const error=e as BusinessError;
        shot.stage=error.code===201 ? Stage.Marked : Stage.Unknown;
        shot.error=error.code===201?'相册权限未获准，请使用系统确认保存':'相册创建回执不明确，原文件保留，需人工核查'; this.journal.persist(shot); throw new Error(shot.error);
      }
      this.journal.persist(shot);
    }
    await this.write(shot);
  }
  async write(shot: Shot): Promise<void> {
    shot.stage=Stage.Writing; this.journal.persist(shot);
    const input=fs.openSync(shot.output,fs.OpenMode.READ_ONLY);
    try {
      const out=fs.openSync(shot.mediaUri,fs.OpenMode.READ_WRITE|fs.OpenMode.TRUNC);
      try { fs.copyFileSync(input.fd,out.fd); fs.fsyncSync(out.fd); } finally { fs.closeSync(out); }
    } finally { fs.closeSync(input); }
    if(await hash(shot.output)!==await hash(shot.mediaUri)) throw new Error('相册内容校验失败，保留私有文件和同一URI重试');
    this.journal.saved(shot);
  }
  async confirmedBatch(shots: Shot[]): Promise<void> {
    // Public third-party fallback; this is an explicit OS confirmation, not silent album access.
    const batch=shots.filter((s: Shot)=>!s.mediaUri && s.stage===Stage.Marked).slice(0,100);
    if(batch.length===0) return;
    const configs: photoAccessHelper.PhotoCreationConfig[]=batch.map((s: Shot)=>({title:'CHUNMO_'+s.id,fileNameExtension:'jpg',photoType:photoAccessHelper.PhotoType.IMAGE}));
    batch.forEach((s: Shot)=>{ s.stage=Stage.Creating; this.journal.persist(s); });
    let uris: string[];
    try { uris=await photoAccessHelper.getPhotoAccessHelper(this.context).showAssetsCreationDialog(batch.map((s: Shot)=>fileUri.getUriFromPath(s.output)),configs); }
    catch { batch.forEach((s: Shot)=>{ s.stage=Stage.Unknown; s.error='系统保存创建结果不明确，源文件保留，禁止重复创建'; this.journal.persist(s); }); throw new Error('系统保存未确认，照片仍保留'); }
    if(uris.length===0) { batch.forEach((s: Shot)=>{ s.stage=Stage.Marked; this.journal.persist(s); }); return; }
    // Persist all returned URI mappings before any long image write.
    batch.forEach((s: Shot,i: number)=>{
      if(i<uris.length && uris[i].startsWith('file://')) { s.mediaUri=uris[i]; s.stage=Stage.Writing; }
      else { s.stage=Stage.Unknown; s.error='系统未返回该张照片的明确URI'; }
      this.journal.persist(s);
    });
    for(const shot of batch) if(shot.mediaUri) await this.write(shot);
  }
  async reconcile(shot: Shot, pickedUri: string): Promise<void> {
    if(await hash(pickedUri)!==await hash(shot.output)) throw new Error('所选相册照片与任务不一致，保留待恢复文件');
    shot.mediaUri=pickedUri; this.journal.saved(shot);
  }
}
