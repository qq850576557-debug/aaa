import { common, abilityAccessCtrl } from '@kit.AbilityKit';
import { geoLocationManager } from '@kit.LocationKit';
import { display } from '@kit.ArkUI';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { Api } from '../core/Api';
import { Journal } from '../core/Journal';
import { SaveQueue } from '../core/SaveQueue';
import { CameraService } from '../core/CameraService';
import { Brand } from '../ui/Brand';
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
  @State loading: boolean=false;
  @State more: boolean=true;
  private searchSerial: number=0;
  private settingsReturn: string='login';
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
  private async search(reset: boolean, relocate: boolean=false): Promise<void> {
    if(this.loading && !reset) return;
    const serial=++this.searchSerial; this.loading=true;
    try {
      if(reset) { this.nextPage=1; this.places=[]; this.selected=undefined; }
      if(relocate || !this.location || Date.now()-Date.parse(this.location.obtainedAt)>90000) {
        const point=await this.gps(); if(serial!==this.searchSerial)return; this.location=point;
      }
      const input: Search={location:this.location!,nearby:true,query:this.query,page:this.nextPage};
      const result=JSON.parse(await this.api.request('/api/site-photos/location',JSON.stringify(input))) as Places;
      if(serial!==this.searchSerial) return;
      const incoming=result.places.filter((p: Place)=>fresh(p.receipt));
      this.places=this.places.concat(incoming.filter((p: Place)=>!this.places.some((old: Place)=>old.id===p.id))).sort((a: Place,b: Place)=>a.distance-b.distance);
      if(!this.selected && this.places.length>0) this.selected=this.places[0].receipt;
      this.nextPage++; this.more=result.more;
      this.notice=this.places.length===0?'2公里内无有效高德地点，请重新定位或搜索':'';
    } catch { if(serial===this.searchSerial)this.notice='定位或地点查询未完成，请检查授权和网络后重试'; }
    finally { if(serial===this.searchSerial)this.loading=false; }
  }
  private async renew(): Promise<void> {
    if(!this.selected) return; this.refreshing=true;
    try { const p=this.selected; const input: Renew={location:await this.gps(),previousToken:p.token,previousAt:p.resolvedAt}; const next=JSON.parse(await this.api.request('/api/site-photos/place',JSON.stringify(input))) as Receipt; if(this.selected===p && this.screen==='camera')this.selected=next; }
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
    } catch { this.notice='登录或授权未完成，请检查账号、网络及权限'; }
  }
  private async confirmSave(): Promise<void> {
    if(!this.queue || !this.journal || !this.api.actor) return;
    try {
      await this.queue.prepareForConsent();
      const actor=this.api.actor;
      const pending=this.journal.all().filter((s)=>s.actor.id===actor.id && s.actor.workspaceId===actor.workspaceId && s.stage===Stage.Marked);
      await this.queue.confirmedBatch(pending); this.tick();
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
  @Builder
  private primary(label: string, action: ()=>void) {
    Button(label).width('100%').height(Brand.control).borderRadius(12).fontSize(16)
      .fontColor('#ffffff').backgroundColor(Brand.green).onClick(action)
  }
  @Builder
  private loginView() {
    Scroll() {
      Column({space:18}) {
        Column({space:14}) {
          Image($rawfile('chunmo-original.jpg')).width(72).height(72).borderRadius(36).objectFit(ImageFit.Contain)
          Row({space:10}) {
            Image($media('camera_outline')).width(28).height(28)
            Text('春茉工地拍照').fontSize(23).fontWeight(FontWeight.Medium).fontColor('#ffffff')
          }
        }.width('100%').padding(28).backgroundColor(Brand.green).borderRadius(18)
        Column({space:8}) {
          Text('员工账号').fontSize(13).fontColor(Brand.muted)
          TextInput({text:this.account,placeholder:'输入员工账号'}).height(Brand.control).backgroundColor('#ffffff').borderRadius(12)
            .border({width:1,color:Brand.edge}).onChange((s: string)=>{this.account=s;})
        }.width('100%').alignItems(HorizontalAlign.Start)
        Column({space:8}) {
          Text('登录密码').fontSize(13).fontColor(Brand.muted)
          TextInput({text:this.password,placeholder:'输入密码'}).height(Brand.control).type(InputType.Password)
            .backgroundColor('#ffffff').borderRadius(12).border({width:1,color:Brand.edge}).onChange((s: string)=>{this.password=s;})
        }.width('100%').alignItems(HorizontalAlign.Start)
        this.primary('登录',()=>this.login())
      }.width('100%').padding(22).backgroundColor('#ffffff').borderRadius(22)
    }.layoutWeight(1).width('100%').scrollBar(BarState.Off)
  }
  @Builder
  private placesView() {
    Row({space:8}) {
      TextInput({text:this.query,placeholder:'搜索附近地点'}).layoutWeight(1).height(48).backgroundColor('#ffffff').borderRadius(12)
        .onChange((s: string)=>{this.query=s;}).onSubmit(()=>this.search(true))
      Button('搜索').height(48).backgroundColor(Brand.green).fontColor('#ffffff').onClick(()=>this.search(true))
    }.width('100%')
    Row() {
      Text(this.loading?'正在定位和查询':(this.location?'实时定位 · 精度约±'+Math.round(this.location.accuracy)+'米':'定位未获取'))
        .layoutWeight(1).fontSize(12).fontColor(Brand.muted)
      Button('重新定位').fontSize(13).fontColor(Brand.green).backgroundColor('#ffffff').onClick(()=>this.search(true,true))
    }.width('100%')
    List({space:10}) {
      ForEach(this.places,(p: Place)=>{
        ListItem() {
          Row({space:12}) {
            Column({space:8}) {
              Text(p.name).fontSize(17).fontWeight(FontWeight.Medium).fontColor(Brand.ink)
              Text(p.distance+'米  '+p.address).fontSize(12).fontColor(Brand.muted)
            }.alignItems(HorizontalAlign.Start).layoutWeight(1)
            Text(this.selected?.poi.id===p.id?'✓':'').fontSize(24).fontColor(Brand.green)
          }.width('100%').padding(16).backgroundColor(this.selected?.poi.id===p.id?'#eaf2e9':'#ffffff')
            .borderRadius(Brand.radius).border({width:1,color:this.selected?.poi.id===p.id?Brand.green:Brand.edge})
            .onClick(()=>{this.selected=p.receipt;})
        }
      },(p: Place)=>p.id)
      ListItem() {
        Button(this.more?'加载更多':'已显示全部地点').width('100%').height(46).fontColor(Brand.green).backgroundColor('#ffffff')
          .enabled(this.more && !this.loading).onClick(()=>this.search(false))
      }
    }.layoutWeight(1).width('100%')
    this.primary('确认地点并拍摄',()=>{
      if(this.selected && fresh(this.selected)) {
        this.screen='camera'; this.queue?.renderer.prepare().catch(()=>{this.notice='水印资源未就绪，请重试';});
      } else this.notice='地点已过期，请重新定位';
    })
  }
  @Builder
  private cameraView() {
    Stack({alignContent:Alignment.Center}) {
      Stack({alignContent:Alignment.BottomStart}) {
        XComponent({id:'chunmo-camera',type:XComponentType.SURFACE,controller:this.surface})
          .onLoad(async()=>{try{await this.camera?.open(this.surface.getXComponentSurfaceId(),this.degree());if(this.camera)this.aspect=this.camera.rotate(this.degree());}catch{this.notice='相机开启未完成，请检查权限';}})
          .width('100%').height('100%')
        Column() {
          Row({space:12*this.scale()}) {
            Image($rawfile('chunmo-original.jpg')).width(44*this.scale()).height(44*this.scale()).borderRadius(22*this.scale()).objectFit(ImageFit.Contain)
            Text('春茉设计').fontSize(32*this.scale()).fontWeight(FontWeight.Medium).fontColor('#fffdf1')
          }.height(50*this.scale())
          ForEach(this.detail(),(line: string,index: number)=>{Text(line).fontSize(24*this.scale()).fontColor('#fffdf1').height((index===this.detail().length-1?24:35)*this.scale())})
        }.alignItems(HorizontalAlign.Start).width(Math.min(this.viewW()-32*this.scale(),780*this.scale())).padding(22*this.scale())
          .backgroundColor('#8c152c23').borderRadius(14*this.scale()).margin({left:16*this.scale(),bottom:16*this.scale()})
      }.width(this.viewW()).height(this.viewH())
      Column() {
        Row() {
          Text(this.selected?.placeName || '').fontSize(17).fontWeight(FontWeight.Medium).fontColor('#ffffff').layoutWeight(1)
          Button('关闭').fontColor('#ffffff').backgroundColor('#33244e42').onClick(async()=>{try{await this.camera?.close();this.screen='places';}catch{this.notice='正在暂存照片，请稍候';}})
        }.width('100%').padding(18).backgroundColor('#66152c23')
        Blank()
        Column({space:14}) {
          if(this.notice.length>0){Text(this.notice).fontSize(12).fontColor('#ffffff')}
          Text('已拍 '+this.captured+' · 已存 '+this.saved+' · 失败 '+this.failed).fontSize(14).fontColor('#ffffff')
          Row({space:24}) {
            Button(this.unstored?'重试暂存':'重试保存').fontSize(13).fontColor('#ffffff').backgroundColor('#33244e42')
              .onClick(async()=>{try{if(this.unstored)this.camera?.retryPrivate();else await this.queue?.drain(this.automatic,true);}catch{this.notice='保存未完成，照片仍保留';}})
            Button('').width(76).height(76).borderRadius(38).backgroundColor('#ffffff').border({width:5,color:'#9db67f'})
              .onClick(async()=>{try{if(!this.camera || !this.api.actor || !this.selected)throw new Error('尚未就绪');await this.camera.capture(this.api.actor,this.selected,this.degree());}catch{this.notice='捕获未完成或地点过期，已有文件保留';}})
            Button('完成').fontColor('#ffffff').backgroundColor('#33244e42').onClick(async()=>{try{await this.camera?.close();this.screen='places';if(!this.automatic)await this.confirmSave();}catch{this.notice='正在捕获或暂存，请稍候';}})
          }.width('100%').justifyContent(FlexAlign.Center)
        }.width('100%').padding({left:12,right:12,top:16,bottom:28}).backgroundColor('#66152c23')
      }.width('100%').height('100%')
    }.width('100%').height('100%').backgroundColor('#000000')
      .onAreaChange((old: Area,area: Area)=>{this.frameWidth=Number(area.width);this.frameHeight=Number(area.height);})
  }
  build() {
    Stack() {
      if(this.screen==='camera') { this.cameraView() }
      else {
        Column({space:12}) {
          Row() {
            if(this.screen!=='login'){Button('‹').fontColor(Brand.green).backgroundColor('#ffffff').onClick(()=>{this.screen=this.screen==='settings'?this.settingsReturn:'login';})}
            Text(this.screen==='login'?'':(this.screen==='settings'?'设置':'选择拍摄地点')).fontSize(21).fontWeight(FontWeight.Medium).fontColor(Brand.ink).layoutWeight(1)
            if(this.screen!=='settings'){Button('设置').fontColor(Brand.green).backgroundColor('#ffffff').onClick(()=>{this.settingsReturn=this.screen;this.screen='settings';})}
          }.width('100%').height(50)
          if(this.screen==='login'){this.loginView()}
          else if(this.screen==='places'){this.placesView()}
          else {
            Text('春茉工地拍照 2.0.0').fontSize(22).fontColor(Brand.ink)
            Text('HarmonyOS · 内部测试版').fontSize(13).fontColor(Brand.muted)
            Button('重试未保存照片').width('100%').height(50).fontColor(Brand.green).backgroundColor('#ffffff').onClick(async()=>{await this.queue?.drain(this.automatic,true);this.tick();})
            if(!this.automatic){this.primary('系统确认保存待存照片',()=>this.confirmSave())}
            if(this.failed>0){Button('核查中断的相册保存').onClick(()=>this.reconcile())}
            Blank()
          }
          if(this.notice.length>0){Text(this.notice).fontSize(13).fontColor(Brand.muted)}
        }.width('100%').height('100%').padding({left:18,right:18,top:28,bottom:24}).backgroundColor(Brand.background)
      }
    }.width('100%').height('100%')
  }
}
