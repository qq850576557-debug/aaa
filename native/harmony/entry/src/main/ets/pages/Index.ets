import { common, abilityAccessCtrl } from '@kit.AbilityKit';
import { geoLocationManager } from '@kit.LocationKit';
import { display } from '@kit.ArkUI';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { Api } from '../core/Api';
import { Journal } from '../core/Journal';
import { SaveQueue } from '../core/SaveQueue';
import { CameraService } from '../core/CameraService';
import { GpsPoint, Place, Places, Search, Renew, Receipt, Stage, fresh, watermarkLines } from '../core/Protocol';

@Entry
@Component
struct Index {
  @State screen: string='login';
  @State account: string='';
  @State password: string='';
  @State query: string='';
  @State notice: string='';
  @State places: Place[]=[];
  @State selected: Receipt | undefined=undefined;
  @State captured: number=0;
  @State saved: number=0;
  @State failed: number=0;
  @State at: string=new Date().toISOString();
  @State aspect: number=0.75;
  @State frameWidth: number=1;
  @State frameHeight: number=1;
  @State unstored: boolean=false;
  private api: Api=new Api();
  private journal?: Journal;
  private queue?: SaveQueue;
  private camera?: CameraService;
  private automatic: boolean=false;
  private location?: GpsPoint;
  private nextPage: number=1;
  private timer: number=0;
  private refreshing: boolean=false;
  private surface: XComponentController=new XComponentController();
  private ctx(): common.UIAbilityContext { return this.getUIContext().getHostContext() as common.UIAbilityContext; }
  aboutToAppear(): void {
    this.journal=new Journal(this.ctx()); this.queue=new SaveQueue(this.ctx(),this.journal);
    this.camera=new CameraService(this.ctx(),this.journal,()=>{ this.tick(); },(s: string)=>{ this.notice=s; });
    this.timer=setInterval(()=>this.tick(),1000);
  }
  aboutToDisappear(): void { clearInterval(this.timer); if(this.camera) this.camera.close().catch(()=>{}); }
  private degree(): number { return Number(display.getDefaultDisplaySync().rotation)*90; }
  private tick(): void {
    this.at=new Date().toISOString();
    this.unstored=this.camera?.hasUnstored || false;
    if(!this.journal || !this.api.actor) return;
    if(this.queue?.needsConsent) this.automatic=false;
    const actor=this.api.actor;
    const all=this.journal.all().filter((s)=>s.actor.id===actor.id && s.actor.workspaceId===actor.workspaceId);
    this.captured=all.filter((s)=>s.stage!==Stage.Capturing).length;
    this.saved=all.filter((s)=>s.stage===Stage.Saved).length;
    this.failed=all.filter((s)=>s.stage===Stage.Failed || s.stage===Stage.Unknown).length;
    if(this.screen==='camera' && this.camera) {
      this.aspect=this.camera.rotate(this.degree());
      if(this.selected && Date.now()-Date.parse(this.selected.location.obtainedAt)>45000 && !this.refreshing) this.renew();
    }
    // Serial limit: never decode all full-resolution shots at once.
    if(this.queue && !this.queue.busy) this.queue.drain(this.automatic).catch((e: Error)=>{ this.notice=e.message; });
  }
  private viewW(): number { return Math.min(this.frameWidth,this.frameHeight*this.aspect); }
  private viewH(): number { return this.viewW()/this.aspect; }
  private scale(): number { return Math.min(this.viewW()/1100,this.viewH()/800); }
  private detail(): string[] { return watermarkLines(this.selected?.placeName || '',this.at,this.api.actor?.name || ''); }
  private async gps(): Promise<GpsPoint> {
    const loc=await geoLocationManager.getCurrentLocation({priority:geoLocationManager.LocationRequestPriority.ACCURACY,maxAccuracy:100,timeoutMs:20000});
    const point: GpsPoint={latitude:loc.latitude,longitude:loc.longitude,accuracy:loc.accuracy,obtainedAt:new Date(loc.timeStamp).toISOString()};
    const age=Date.now()-Date.parse(point.obtainedAt);
    if(point.accuracy>100 || age>90000 || age < -5000) throw new Error('定位精度或时效不足，请重试');
    return point;
  }
  private async search(reset: boolean): Promise<void> {
    try {
      if(reset || !this.location) { this.location=await this.gps(); this.nextPage=1; this.places=[]; this.selected=undefined; }
      const input: Search={location:this.location!,nearby:true,query:this.query,page:this.nextPage};
      const result=JSON.parse(await this.api.request('/api/site-photos/location',JSON.stringify(input))) as Places;
      const incoming=result.places.filter((p: Place)=>fresh(p.receipt));
      this.places=this.places.concat(incoming.filter((p: Place)=>!this.places.some((old: Place)=>old.id===p.id))).sort((a: Place,b: Place)=>a.distance-b.distance);
      if(!this.selected && this.places.length>0) this.selected=this.places[0].receipt;
      this.nextPage++; this.notice=this.places.length===0?'2公里内无有效高德地点，请重新定位或搜索':'';
    } catch(e) { this.notice=`${e}`; }
  }
  private async renew(): Promise<void> {
    if(!this.selected) return; this.refreshing=true;
    try { const p=this.selected; const input: Renew={location:await this.gps(),previousToken:p.token,previousAt:p.resolvedAt}; this.selected=JSON.parse(await this.api.request('/api/site-photos/place',JSON.stringify(input))) as Receipt; }
    catch(e) { this.notice=`位置更新失败，过期后暂停快门：${e}`; }
    finally { this.refreshing=false; }
  }
  private async login(): Promise<void> {
    try {
      const password=this.password; this.password=''; await this.api.login(this.account,password);
      const auth=await abilityAccessCtrl.createAtManager().requestPermissionsFromUser(this.ctx(),['ohos.permission.CAMERA','ohos.permission.APPROXIMATELY_LOCATION','ohos.permission.LOCATION']);
      if(auth.authResults.some((v: number)=>v!==0)) throw new Error('相机和精确定位权限未获准');
      try { const album=await abilityAccessCtrl.createAtManager().requestPermissionsFromUser(this.ctx(),['ohos.permission.WRITE_IMAGEVIDEO']); this.automatic=album.authResults.length>0 && album.authResults[0]===0; }
      catch { this.automatic=false; }
      this.screen='places'; await this.search(true);
      if(!this.automatic) this.notice='未取得自动相册写入权限；照片暂存后需系统确认保存';
    } catch(e) { this.notice=`${e}`; }
  }
  private async confirmSave(): Promise<void> {
    if(!this.queue || !this.journal || !this.api.actor) return;
    try {
      await this.queue.drain(false,true);
      const actor=this.api.actor;
      const pending=this.journal.all().filter((s)=>s.actor.id===actor.id && s.actor.workspaceId===actor.workspaceId && s.stage===Stage.Marked);
      await this.queue.album.confirmedBatch(pending); this.tick();
    } catch(e) { this.notice=`保存未完成：${e}，文件仍保留`; }
  }
  private async reconcile(): Promise<void> {
    if(!this.queue || !this.journal || !this.api.actor) return;
    const actor=this.api.actor;
    const shot=this.journal.all().find((s)=>s.actor.id===actor.id && s.actor.workspaceId===actor.workspaceId && s.stage===Stage.Unknown);
    if(!shot) { this.notice='没有待核查任务'; return; }
    try {
      const result=await new photoAccessHelper.PhotoViewPicker().select({MIMEType:photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE,maxSelectNumber:1});
      if(result.photoUris.length>0) await this.queue.album.reconcile(shot,result.photoUris[0]); this.tick();
    } catch(e) { this.notice=`核查未完成：${e}`; }
  }
  build() {
    Column({space:12}) {
      if(this.screen==='login') {
        Text('春茉工地拍照').fontSize(24)
        TextInput({text:this.account,placeholder:'现有管理系统账号'}).onChange((s: string)=>{this.account=s;})
        TextInput({text:this.password,placeholder:'密码'}).type(InputType.Password).onChange((s: string)=>{this.password=s;})
        Button('登录').onClick(()=>this.login())
      } else if(this.screen==='places') {
        Text('选择拍摄地点').fontSize(22)
        TextInput({text:this.query,placeholder:'搜索2公里内地点'}).onChange((s: string)=>{this.query=s;})
        Button('搜索 / 重新定位').onClick(()=>this.search(true))
        List({space:8}) {
          ForEach(this.places,(p: Place)=>{ ListItem(){ Text(`${this.selected?.poi.id===p.id?'✓ ':''}${p.name} · ${p.distance}米`).padding(12).onClick(()=>{this.selected=p.receipt;}) } },(p: Place)=>p.id)
        }.layoutWeight(1)
        Button('加载更多').onClick(()=>this.search(false))
        Button('确认地点并拍摄').enabled(this.selected!==undefined).onClick(()=>{
          if(this.selected && fresh(this.selected)) { this.screen='camera'; this.queue?.renderer.prepare().catch((e: Error)=>{this.notice=e.message;}); }
          else this.notice='地点已过期，请重新定位';
        })
        Button('重试未保存照片').onClick(async()=>{await this.queue?.drain(this.automatic,true);this.tick();})
        if(!this.automatic) { Button('系统确认保存待存照片').onClick(()=>this.confirmSave()) }
        if(this.failed>0) { Button('核查中断的相册保存').onClick(()=>this.reconcile()) }
      } else {
        Text(this.selected?.placeName || '').fontSize(20)
        Stack({alignContent:Alignment.Center}) {
        Stack({alignContent:Alignment.BottomStart}) {
          XComponent({id:'chunmo-camera',type:XComponentType.SURFACE,controller:this.surface})
            .onLoad(async()=>{ try{ await this.camera?.open(this.surface.getXComponentSurfaceId(),this.degree()); if(this.camera)this.aspect=this.camera.rotate(this.degree()); }catch(e){this.notice=`${e}`;} })
            .width('100%').height('100%')
          Column() {
            Row({space:12*this.scale()}){ Image($rawfile('chunmo-original.jpg')).width(44*this.scale()).height(44*this.scale()).borderRadius(22*this.scale()); Text('春茉设计').fontSize(32*this.scale()).fontWeight(FontWeight.Medium).fontColor('#fffdf1') }.height(50*this.scale())
            ForEach(this.detail(),(line: string,index: number)=>{ Text(line).fontSize(24*this.scale()).fontColor('#fffdf1').height((index===this.detail().length-1?24:35)*this.scale()) })
          }.alignItems(HorizontalAlign.Start).width(Math.min(this.viewW()-32*this.scale(),780*this.scale()))
            .padding(22*this.scale()).backgroundColor('#8c152c23').borderRadius(14*this.scale()).margin({left:16*this.scale(),bottom:16*this.scale()})
        }.width(this.viewW()).height(this.viewH())
        }.width('100%').layoutWeight(1).backgroundColor('#000000').onAreaChange((old: Area,area: Area)=>{this.frameWidth=Number(area.width);this.frameHeight=Number(area.height);})
        Text(`已拍 ${this.captured} · 已存 ${this.saved} · 失败 ${this.failed}`)
        Row({space:20}) {
          if(this.unstored) { Button('重试暂存').onClick(()=>{try{this.camera?.retryPrivate();this.tick();}catch(e){this.notice=`${e}`;}}) }
          else { Button('●').fontSize(38).onClick(async()=>{ try{
            if(!this.camera || !this.api.actor || !this.selected) throw new Error('相机或身份未就绪');
            const pending=this.journal!.all().filter((s)=>s.stage!==Stage.Saved && s.stage!==Stage.Failed && s.stage!==Stage.Unknown).length;
            if(pending>=12) throw new Error('照片正在处理，请稍后继续');
            await this.camera.capture(this.api.actor,this.selected,this.degree());
          }catch(e){this.notice=`${e}`;} }) }
          Button('完成').onClick(async()=>{ try{ await this.camera?.close(); this.screen='places'; if(!this.automatic) await this.confirmSave(); }catch(e){this.notice=`${e}`;} })
        }
      }
      if(this.notice.length>0){ Text(this.notice).fontSize(13).fontColor('#8c4938') }
    }.width('100%').height('100%').padding({left:12,right:12,top:28,bottom:28}).backgroundColor('#f9faf4')
  }
}
