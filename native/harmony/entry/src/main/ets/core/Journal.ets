import { fileIo as fs } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { Shot, Stage, Identity, Receipt, fresh } from './Protocol';

export class Journal {
  root: string;
  revision: number=0;
  private loaded: boolean=false;
  private cached: Shot[]=[];
  constructor(context: common.UIAbilityContext) { this.root=context.filesDir+'/native-photo'; if (!fs.accessSync(this.root)) fs.mkdirSync(this.root); }
  persist(shot: Shot): void {
    this.bytes(this.root+'/'+shot.id+'.json.tmp',new util.TextEncoder().encodeInto(JSON.stringify(shot)).buffer);
    fs.renameSync(this.root+'/'+shot.id+'.json.tmp',this.root+'/'+shot.id+'.json');
    if(this.loaded) {
      const copy=JSON.parse(JSON.stringify(shot)) as Shot;
      const index=this.cached.findIndex((s: Shot)=>s.id===shot.id);
      if(index>=0)this.cached[index]=copy;else this.cached.push(copy);
    }
    this.revision++;
  }
  async bytesAsync(path: string, buffer: ArrayBuffer): Promise<void> {
    const f=await fs.open(path,fs.OpenMode.CREATE|fs.OpenMode.READ_WRITE|fs.OpenMode.TRUNC);
    try { let at=0; while(at<buffer.byteLength) { const n=await fs.write(f.fd,buffer.slice(at)); if(n<=0)throw new Error('写入未完成'); at+=n; } await fs.fsync(f.fd); }
    finally { await fs.close(f); }
  }
  bytes(path: string, buffer: ArrayBuffer): void {
    const f=fs.openSync(path,fs.OpenMode.CREATE|fs.OpenMode.READ_WRITE|fs.OpenMode.TRUNC);
    try { let at=0; while(at<buffer.byteLength) { const n=fs.writeSync(f.fd,buffer.slice(at)); if(n<=0) throw new Error('写入未完成'); at+=n; } fs.fsyncSync(f.fd); }
    finally { fs.closeSync(f); }
  }
  all(): Shot[] {
    if(this.loaded)return this.cached.map((s: Shot)=>JSON.parse(JSON.stringify(s)) as Shot).sort((a: Shot,b: Shot)=>a.capturedAt.localeCompare(b.capturedAt));
    const result: Shot[]=[];
    fs.listFileSync(this.root).filter((name: string)=>name.endsWith('.json')).forEach((name: string)=>{
      try { result.push(JSON.parse(fs.readTextSync(this.root+'/'+name)) as Shot); } catch { /* Unknown files are retained. */ }
    });
    this.cached=result;this.loaded=true;
    return this.cached.map((s: Shot)=>JSON.parse(JSON.stringify(s)) as Shot).sort((a: Shot,b: Shot)=>a.capturedAt.localeCompare(b.capturedAt));
  }
  create(actor: Identity, receipt: Receipt): Shot {
    if(!fresh(receipt)) throw new Error('地点凭据过期，请重新定位');
    const pending=this.all().filter((s: Shot)=>s.stage!==Stage.Saved);
    if(pending.length>=100) throw new Error('本批待保存照片已达安全上限，请先完成系统保存');
    const processing=pending.filter((s: Shot)=>s.stage!==Stage.Marked && s.stage!==Stage.Failed && s.stage!==Stage.Unknown);
    if(processing.length>=12) throw new Error('照片处理队列已满，请稍后继续');
    const id=util.generateRandomUUID(true);
    const shot: Shot={ id:id, actor:actor, receipt:receipt, capturedAt:new Date().toISOString(), stage:Stage.Capturing,
      raw:this.root+'/'+id+'-raw.jpg', output:this.root+'/'+id+'-marked.jpg', mediaUri:'', error:'', width:0, height:0 };
    this.persist(shot); return shot;
  }
  saved(shot: Shot): void {
    shot.stage=Stage.Saved; shot.error=''; this.persist(shot);
    // Called only after acknowledged write+readback. The durable receipt remains.
    try { if(fs.accessSync(shot.raw)) fs.unlinkSync(shot.raw); } catch { }
    try { if(fs.accessSync(shot.output)) fs.unlinkSync(shot.output); } catch { }
  }
}
