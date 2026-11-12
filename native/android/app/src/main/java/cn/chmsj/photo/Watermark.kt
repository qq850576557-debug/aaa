package cn.chmsj.photo

import android.content.Context
import android.graphics.*
import android.view.View
import androidx.exifinterface.media.ExifInterface
import java.io.File
import java.io.FileOutputStream
import kotlin.math.min

private object BrandBitmap {
    @Volatile private var cached: Bitmap? = null
    fun get(context: Context): Bitmap = cached ?: synchronized(this) {
        cached ?: BitmapFactory.decodeResource(context.applicationContext.resources, R.drawable.chunmo_original,
            BitmapFactory.Options().apply { inScaled=false; inSampleSize=2 }).also { cached=it }
    }
}
class WatermarkRenderer(private val context: Context) {
    private val logo get() = BrandBitmap.get(context)
    fun prepare() { BrandBitmap.get(context) }
    fun draw(canvas: Canvas, width: Int, height: Int, place: String, at: String, name: String) {
        val m = markLayout(width, height, place, at, name); val s = m.scale
        val p = Paint(Paint.ANTI_ALIAS_FLAG)
        p.color = Color.argb(140, 21, 44, 35)
        canvas.drawRoundRect(m.x, m.y, m.x+m.width, m.y+m.height, 14*s, 14*s, p)
        val x = m.x+22*s; val y = m.y+22*s
        canvas.save()
        canvas.clipPath(Path().apply { addCircle(x+22*s, y+22*s, 22*s, Path.Direction.CW) })
        canvas.drawBitmap(logo, null, RectF(x,y,x+44*s,y+44*s), Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG))
        canvas.restore()
        p.color = Color.rgb(255,253,241); p.typeface = Typeface.create("sans-serif", Typeface.BOLD); p.textSize = 32*s
        canvas.drawText("春茉设计", x+56*s, y+22*s+32*s*.38f, p)
        p.typeface = Typeface.create("sans-serif", Typeface.NORMAL); p.textSize = 24*s
        m.lines.forEachIndexed { i, line -> canvas.drawText(line, x, y+50*s+24*s+35*s*i, p) }
    }
    fun render(task: Task) {
        val started = System.nanoTime()
        check(placeFresh(task.data.getJSONObject("receipt"), java.time.Instant.parse(task.data.getString("capturedAt")).toEpochMilli())) { "拍摄时定位已过期，原文件保留，请重新定位后拍摄" }
        java.io.RandomAccessFile(task.raw,"r").use {
            check(it.length() > 4) { "捕获文件未完成" }; it.seek(it.length()-2)
            check(it.readUnsignedByte()==255 && it.readUnsignedByte()==217) { "捕获JPEG不完整，原文件保留" }
        }
        val exif = ExifInterface(task.raw); val orientation = exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, 1)
        val options = BitmapFactory.Options().apply { inMutable = true; inPreferredConfig = Bitmap.Config.ARGB_8888 }
        var bitmap = BitmapFactory.decodeFile(task.raw.path, options) ?: error("捕获照片不完整，原文件仍保留")
        try {
            if (orientation in 2..8) {
                val matrix = Matrix().apply { when(orientation) {
                    2 -> setScale(-1f,1f); 3 -> setRotate(180f); 4 -> setScale(1f,-1f)
                    5 -> { setRotate(90f); postScale(-1f,1f) }; 6 -> setRotate(90f)
                    7 -> { setRotate(-90f); postScale(-1f,1f) }; 8 -> setRotate(-90f)
                } }
                val rotated = Bitmap.createBitmap(bitmap,0,0,bitmap.width,bitmap.height,matrix,true)
                if (rotated !== bitmap) { bitmap.recycle(); bitmap = rotated }
            }
            if (!bitmap.isMutable) { val next = bitmap.copy(Bitmap.Config.ARGB_8888, true); bitmap.recycle(); bitmap = next }
            draw(Canvas(bitmap), bitmap.width, bitmap.height, task.data.getJSONObject("receipt").getString("placeName"), task.data.getString("capturedAt"), task.actor.name)
            val tmp = File(task.dir, "watermarked.tmp")
            val encoding=System.nanoTime()
            FileOutputStream(tmp).use { out -> check(bitmap.compress(Bitmap.CompressFormat.JPEG, 95, out)) { "JPEG编码失败" }; out.flush(); out.fd.sync() }
            task.data.put("encodeMs",(System.nanoTime()-encoding)/1000000)
            // Preserve real location, precision, POI provenance and identity outside the visible watermark.
            ExifInterface(tmp).apply {
                setAttribute(ExifInterface.TAG_ORIENTATION, "1")
                setAttribute(ExifInterface.TAG_DATETIME_ORIGINAL, java.time.format.DateTimeFormatter.ofPattern("yyyy:MM:dd HH:mm:ss")
                    .withZone(java.time.ZoneId.of("Asia/Shanghai")).format(java.time.Instant.parse(task.data.getString("capturedAt"))))
                setAttribute(ExifInterface.TAG_OFFSET_TIME_ORIGINAL, "+08:00")
                val provenance = org.json.JSONObject(task.data.getJSONObject("receipt").toString()).apply { remove("token") }
                setAttribute(ExifInterface.TAG_USER_COMMENT, org.json.JSONObject().put("id",task.id).put("actor",task.actor.json())
                    .put("capturedAt",task.data.getString("capturedAt")).put("place",provenance).toString())
                val location = task.data.getJSONObject("receipt").getJSONObject("location")
                setLatLong(location.getDouble("latitude"), location.getDouble("longitude")); saveAttributes()
            }
            java.io.RandomAccessFile(tmp,"rw").use { it.fd.sync() }
            check(tmp.renameTo(task.marked)) { "水印文件落盘失败，原图仍保留" }
            task.data.put("width",bitmap.width).put("height",bitmap.height).put("sha256",fileHash(task.marked))
                .put("watermarkMs", (System.nanoTime()-started)/1_000_000)
            task.stage = Stage.WATERMARKED; task.save()
            Performance.record(context,"watermark",(System.nanoTime()-started)/1000000,task.id,"${bitmap.width}x${bitmap.height};encodeMs=${task.data.getLong("encodeMs")}")
        } finally { bitmap.recycle() }
    }
}
class WatermarkView(context: Context) : View(context) {
    var place = ""; var at = java.time.Instant.now().toString(); var actor = ""
    var photoWidth = 3000; var photoHeight = 4000
    private val renderer = WatermarkRenderer(context)
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (place.isEmpty() || width == 0 || height == 0) return
        val factor = min(width.toFloat()/photoWidth, height.toFloat()/photoHeight)
        canvas.save(); canvas.translate((width-photoWidth*factor)/2,(height-photoHeight*factor)/2); canvas.scale(factor,factor)
        renderer.draw(canvas,photoWidth,photoHeight,place,at,actor); canvas.restore()
    }
}
