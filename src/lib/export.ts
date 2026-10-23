import {days,distance,duration,lanes,projectRange,weekday,type Data,type Project} from './model';
export function downloadBlob(blob:Blob,name:string){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
export function backupJSON(data:Data){downloadBlob(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),`春茉空间-完整备份-${new Date().toISOString().slice(0,10)}.json`);}
export const exportFilename=(name:string)=>`${name.replace(/[\\/:*?"<>|]/g,'-')}-施工工期.png`;
// Render the entire schedule from data. Horizontal viewport and UI scroll positions are irrelevant.
// Fixed-size date panels keep long, cross-year schedules within browser canvas limits.
export async function schedulePNG(data:Data,project:Project):Promise<Blob>{
 await document.fonts.ready;
 const [start,end]=projectRange(data,project);const dates=days(start,end);const trades=data.trades.filter(g=>g.projectId===project.id).sort((a,b)=>a.order-b.order);
 const groups=trades.map(g=>({g,rows:lanes(data.tasks.filter(t=>t.projectId===project.id&&t.tradeId===g.id))}));
 const perPanel=45,cell=42,label=210,margin=48,width=margin*2+label+Math.min(perPanel,dates.length)*cell;
 const rowHeights=groups.map(x=>Math.max(64,x.rows.length*34+16));const chartHeight=68+rowHeights.reduce((a,b)=>a+b,0);
 const panels=Math.ceil(dates.length/perPanel);
 const temp=document.createElement('canvas').getContext('2d')!;temp.font='14px sans-serif';
 const wrap=(s:string,max:number)=>{const out:string[]=[];let line='';for(const ch of s.replace(/\r/g,'')){if(ch==='\n'){out.push(line);line='';continue;}if(temp.measureText(line+ch).width>max){out.push(line);line=ch;}else line+=ch;}if(line||!out.length)out.push(line);return out;};
 const notes=data.notes.filter(n=>n.projectId===project.id).sort((a,b)=>a.date.localeCompare(b.date)).flatMap(n=>wrap(`${n.done?'✓':'○'} ${n.date||'项目备忘'} · ${n.kind} · ${n.title}${n.owner?' / '+n.owner:''}${n.content?'：'+n.content:''}`,width-margin*2));
 const projectNotes=project.notes?wrap(`项目备注：${project.notes}`,width-margin*2):[];
 const legendRows=Math.max(1,Math.ceil(trades.length/5));const header=190+legendRows*28;
 const height=header+panels*(chartHeight+50)+80+(notes.length+projectNotes.length)*24;
 const scale=1.5;if(width*height*scale*scale>50000000||height*scale>32000)throw new Error('项目记录过多，超出浏览器单张 PNG 安全尺寸。请减少导出事项或拆分项目后重试；数据未更改。');
 const canvas=document.createElement('canvas');canvas.width=Math.ceil(width*scale);canvas.height=Math.ceil(height*scale);const ctx=canvas.getContext('2d');if(!ctx)throw new Error('浏览器不支持图片生成');ctx.scale(scale,scale);ctx.fillStyle='#faf9f5';ctx.fillRect(0,0,width,height);ctx.textBaseline='middle';
 const text=(s:string,x:number,y:number,size=14,color='#293f35',bold=false,max?:number)=>{ctx.fillStyle=color;ctx.font=`${bold?'600':'400'} ${size}px "PingFang SC", "Microsoft YaHei", sans-serif`;if(max&&ctx.measureText(s).width>max){let v=s;while(v&&ctx.measureText(v+'…').width>max)v=v.slice(0,-1);s=v+'…';}ctx.fillText(s,x,y);};
 const line=(x:number,y:number,w:number,h:number,color='#e4e8e1')=>{ctx.fillStyle=color;ctx.fillRect(x,y,w,h);};
 const logo=new Image();logo.src='/brand.svg';await logo.decode();ctx.drawImage(logo,margin,24,48,56);
 text('春茉空间设计',margin+64,44,23,'#244e42',true);text('CHUNMO SPACE DESIGN  /  施工工期计划',margin+64,70,11,'#748277');
 text(project.name,margin,116,26,'#244e42',true,width-margin*2);text(`${project.start} — ${project.end}  ·  计划 ${duration(project.start,project.end)} 天（含首尾）  ·  ${project.status}`,margin,153,15);
 trades.forEach((g,i)=>{const x=margin+(i%5)*(width-margin*2)/5,y=189+Math.floor(i/5)*28;line(x,y-5,10,10,g.color);text(g.name,x+18,y,13,'#4c5e53',false,(width-margin*2)/5-26);});
 let y=header;
 for(let panel=0;panel<panels;panel++){
  const ds=dates.slice(panel*perPanel,(panel+1)*perPanel);text(`${ds[0]} — ${ds.at(-1)}   /   ${panel+1} · ${panels}`,margin,y+12,13,'#6b7b70');y+=32;
  line(margin,y,width-margin*2,chartHeight,'#ffffff');text('施工工种 / 日期',margin+14,y+32,13,'#56695b',true);
  ds.forEach((d,i)=>{const x=margin+label+i*cell;const weekend=['六','日'].includes(weekday(d));if(weekend)line(x,y,cell,chartHeight,'#f3f5ef');line(x,y,1,chartHeight);text(d.slice(5,7)+'/'+d.slice(8),x+5,y+22,11);text('周'+weekday(d),x+10,y+46,11,'#849087');});
  line(margin,y+67,width-margin*2,1);let rowY=y+68;
  groups.forEach(({g,rows},ri)=>{const rh=rowHeights[ri];line(margin+14,rowY+24,8,8,g.color);text(g.name,margin+30,rowY+28,13,'#344c3e',true,label-40);
   rows.forEach((row,lane)=>row.forEach(t=>{if(t.start>ds.at(-1)!||t.end<ds[0])return;const a=t.start<ds[0]?ds[0]:t.start,b=t.end>ds.at(-1)!?ds.at(-1)!:t.end;const x=margin+label+distance(ds[0],a)*cell+3,w=duration(a,b)*cell-6,ty=rowY+10+lane*34;ctx.fillStyle=g.color+'40';ctx.strokeStyle=g.color;ctx.lineWidth=1;ctx.beginPath();ctx.roundRect(x,ty,w,27,4);ctx.fill();ctx.stroke();ctx.save();ctx.beginPath();ctx.rect(x+3,ty,w-6,27);ctx.clip();text(`${t.status==='已完成'?'✓ ':''}${t.name} · ${duration(t.start,t.end)}天`,x+7,ty+14,12,'#2a3f33',false,w-12);ctx.restore();}));
   rowY+=rh;line(margin,rowY-1,width-margin*2,1);
  });
  y+=chartHeight+18;
 }
 y+=14;for(const n of [...projectNotes,...notes]){text(n,margin,y,14);y+=24;}text(`春茉空间设计 · 本地项目计划 · 导出于 ${new Date().toLocaleString('zh-CN')}`,margin,height-24,11,'#839085');
 return new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('PNG 生成失败')),'image/png'));
}
