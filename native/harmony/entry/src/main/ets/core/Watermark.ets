import { image } from '@kit.ImageKit';
import { drawing, text } from '@kit.ArkGraphics2D';
import { common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { Journal } from './Journal';
import { Shot, Stage, nativeMark } from './Protocol';

export class Watermark {
  private logo?: image.PixelMap;
  constructor(private context: common.UIAbilityContext, private journal: Journal) {}
  async prepare(): Promise<void> {
    if(this.logo) return;
    const bytes=await this.context.resourceManager.getRawFileContent('chunmo-original.jpg');
    const source=image.createImageSource(bytes.buffer);
    try { this.logo=await source.createPixelMap({desiredSize:{width:256,height:256}}); } finally { source.release(); }
  }
  private label(canvas: drawing.Canvas, content: string, x: number, baseline: number, size: number, width: number, bold: boolean): void {
    const paragraph=new text.ParagraphBuilder({align:text.TextAlign.LEFT},text.FontCollection.getGlobalInstance());
    paragraph.pushStyle({ color:{alpha:255,red:255,green:253,blue:241}, fontSize:size, fontWeight:bold?text.FontWeight.W600:text.FontWeight.W400, fontFamilies:['HarmonyOS Sans SC'] });
    paragraph.addText(content); const result=paragraph.build(); result.layout(width); result.paint(canvas,x,baseline-result.getAlphabeticBaseline());
  }
  async render(shot: Shot): Promise<void> {
    await this.prepare();
    const file=fs.openSync(shot.raw,fs.OpenMode.READ_ONLY); const source=image.createImageSource(file.fd);
    let pixel: image.PixelMap | undefined;
    try {
      pixel=await source.createPixelMap({editable:true,desiredPixelFormat:image.PixelMapFormat.RGBA_8888});
      let orientation='1'; try { orientation=await source.getImageProperty(image.PropertyKey.ORIENTATION); } catch { }
      const o=orientation.toLowerCase();
      if(o==='2'||o==='top-right') await pixel.flip(true,false);
      else if(o==='3'||o==='bottom-right') await pixel.rotate(180);
      else if(o==='4'||o==='bottom-left') await pixel.flip(false,true);
      else if(o==='5'||o==='left-top') { await pixel.rotate(90); await pixel.flip(true,false); }
      else if(o==='6'||o==='right-top') await pixel.rotate(90);
      else if(o==='7'||o==='right-bottom') { await pixel.rotate(270); await pixel.flip(true,false); }
      else if(o==='8'||o==='left-bottom') await pixel.rotate(270);
      else if(o!=='1'&&o!=='top-left') throw new Error('未识别EXIF方向，原文件保留，请使用目标SDK实机核验');
      const info=await pixel.getImageInfo(); const w=info.size.width; const h=info.size.height;
      const mark=nativeMark(w,h,shot.receipt.placeName,shot.capturedAt,shot.actor.name);
      const s=mark.scale; const detail=mark.wrapped; const boxH=mark.boxH;
      const x=mark.x; const y=mark.y; const canvas=new drawing.Canvas(pixel);
      const brush=new drawing.Brush(); brush.setColor({alpha:140,red:21,green:44,blue:35}); canvas.attachBrush(brush);
      canvas.drawRoundRect(new drawing.RoundRect({left:x,top:y,right:x+mark.boxW,bottom:y+boxH},14*s,14*s)); canvas.detachBrush();
      canvas.save(); const clip=new drawing.Path(); clip.addCircle(x+44*s,y+44*s,22*s); canvas.clipPath(clip,drawing.ClipOp.INTERSECT,true);
      canvas.drawImageRect(this.logo!,{left:x+22*s,top:y+22*s,right:x+66*s,bottom:y+66*s}); canvas.restore();
      this.label(canvas,'春茉设计',x+78*s,y+(44+32*0.38)*s,32*s,650*s,true);
      detail.forEach((line: string,i: number)=>this.label(canvas,line,x+22*s,y+96*s+i*35*s,24*s,736*s,false));
      const packer=image.createImagePacker();
      try { const bytes=await packer.packing(pixel,{format:'image/jpeg',quality:95}); this.journal.bytes(shot.output+'.tmp',bytes); fs.renameSync(shot.output+'.tmp',shot.output); }
      finally { packer.release(); }
      shot.width=w; shot.height=h; shot.stage=Stage.Marked; this.journal.persist(shot);
    } finally { if(pixel) pixel.release(); source.release(); fs.closeSync(file); }
  }
}
