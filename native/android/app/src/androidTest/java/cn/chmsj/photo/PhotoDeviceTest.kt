package cn.chmsj.photo

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.os.Build
import android.provider.MediaStore
import androidx.exifinterface.media.ExifInterface
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Test
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.runner.RunWith
import java.io.FileOutputStream
import java.time.Instant
import java.io.IOException

/** Emulator-only synthetic capture files, real Android graphics and system MediaStore; no production login. */
@RunWith(AndroidJUnit4::class)
class PhotoDeviceTest {
    @Test fun deviceKeystoreRoundtripNeverStoresAPlainCookie() {
        val context=context(); val vault=SessionVault(context)
        assumeTrue("Do not replace any existing session",vault.read()==null)
        val fixture=JSONObject().put("origin","https://chmsj.cn").put("cookie","synthetic-cookie-no-real-credentials")
        try {
            vault.save(fixture)
            assertEquals(fixture.toString(),vault.read()!!.toString())
            val sealed=context.getSharedPreferences("native-session",android.content.Context.MODE_PRIVATE).getString("sealed","")!!
            assertFalse(sealed.contains("synthetic-cookie"))
        } finally { vault.clear() }
        assertNull(vault.read())
    }
    @Test fun exportAlreadyPublishedSampleViaAuthorizedContentResolver() {
        val context=context()
        val task=QueueStore(context).all().firstOrNull { it.actor.id=="instrumentation-only" && it.stage==Stage.SAVED && it.data.optInt("width")==4000 }
        assumeTrue("Run the 20-image test first",task!=null)
        val selected=task!!
        val sample=java.io.File(context.cacheDir,"emulator-watermark-4000x3000.jpg")
        context.contentResolver.openInputStream(android.net.Uri.parse(selected.data.getString("mediaUri")))!!.use { input ->
            FileOutputStream(sample).use { input.copyTo(it); it.fd.sync() }
        }
        assertEquals("Published bytes remain accessible through the app's own media URI",selected.data.getString("sha256"),fileHash(sample))
        val b=BitmapFactory.Options().apply { inJustDecodeBounds=true }; BitmapFactory.decodeFile(sample.path,b)
        assertEquals(4000,b.outWidth); assertEquals(3000,b.outHeight)
    }
    private fun context(): android.content.Context {
        assumeTrue("Emulator-only test fixtures",Build.HARDWARE in listOf("ranchu","goldfish"))
        return InstrumentationRegistry.getInstrumentation().targetContext
    }
    private fun fixture(): Task {
        val context=context(); val now=Instant.now()
        val p=JSONObject().put("placeSource","amap-poi-selected").put("placeName","异常恢复模拟地点")
            .put("token","synthetic-only").put("poi",JSONObject().put("id","test"))
            .put("expiresAt",now.plusSeconds(90).toString()).put("location",JSONObject().put("latitude",30).put("longitude",120).put("accuracy",12).put("obtainedAt",now.toString()))
        val task=QueueStore(context).create(Identity("instrumentation-recovery","lab","测试监理"),p,"recovery")
        val b=Bitmap.createBitmap(800,600,Bitmap.Config.ARGB_8888).apply { eraseColor(Color.LTGRAY) }
        FileOutputStream(task.raw).use { b.compress(Bitmap.CompressFormat.JPEG,98,it) }; b.recycle()
        task.stage=Stage.CAPTURED; task.save(); WatermarkRenderer(context).render(task); return task
    }
    private fun rowCount(task: Task): Int = context().contentResolver.query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
        arrayOf(MediaStore.Images.Media._ID),"${MediaStore.Images.Media.DISPLAY_NAME}=?",arrayOf(task.filename),null)!!.use { it.count }
    @Test fun interruptionAfterInsertReusesOneRealMediaStoreRow() {
        val task=fixture(); val context=context()
        assertThrows(IOException::class.java) { AlbumWriter(context) { if(it=="after-insert") throw IOException("synthetic process exit checkpoint") }.publish(task) }
        assertTrue(task.marked.exists())
        val recovered=QueueStore(context).all().first { it.id==task.id }
        AlbumWriter(context).publish(recovered)
        assertEquals(Stage.SAVED,recovered.stage); assertEquals(1,rowCount(task))
    }
    @Test fun interruptionAfterPublicationUsesReceiptWithoutDuplicate() {
        val task=fixture(); val context=context()
        assertThrows(IOException::class.java) { AlbumWriter(context) { if(it=="after-publish") throw IOException("synthetic exit before private receipt") }.publish(task) }
        assertTrue(task.marked.exists())
        val recovered=QueueStore(context).all().first { it.id==task.id }
        AlbumWriter(context).publish(recovered)
        assertEquals(Stage.SAVED,recovered.stage); assertEquals(1,rowCount(task))
    }
    @Test fun simulatedDenialAndFullStorageKeepFilesForRetry() {
        val task=fixture(); val context=context()
        assertThrows(SecurityException::class.java) { AlbumWriter(context) { if(it=="before-insert") throw SecurityException("synthetic permission denial") }.publish(task) }
        assertTrue(task.raw.exists()); assertTrue(task.marked.exists())
        assertThrows(IOException::class.java) { AlbumWriter(context) { if(it=="before-insert") throw IOException("synthetic disk full") }.publish(task) }
        assertTrue(task.marked.exists()); assertEquals(0,rowCount(task))
        AlbumWriter(context).publish(task); assertEquals(Stage.SAVED,task.stage)
    }
    @Test fun twentyNativeWatermarksPublishWithFullPixelsAndRecoverWithoutDuplicate() {
        assumeTrue("Never run fixture creation on a real employee phone", Build.HARDWARE in listOf("ranchu","goldfish"))
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val actor=Identity("instrumentation-only","isolated-emulator","测试监理")
        val store=QueueStore(context)
        val times=mutableListOf<Long>()
        repeat(20) { index ->
            val started=System.nanoTime()
            val now=Instant.now()
            val receipt=JSONObject().put("placeSource","amap-poi-selected").put("placeName","模拟器测试现场")
                .put("token","synthetic-no-live-map").put("poi",JSONObject().put("id","test"))
                .put("expiresAt",now.plusSeconds(90).toString())
                .put("location",JSONObject().put("latitude",30).put("longitude",120).put("accuracy",12).put("obtainedAt",now.toString()))
            val task=store.create(actor,receipt,"instrumentation")
            val width=if(index==0)4000 else 1200; val height=if(index==0)3000 else 800
            val original=Bitmap.createBitmap(width,height,Bitmap.Config.ARGB_8888)
            original.eraseColor(Color.rgb(190,205,180))
            FileOutputStream(task.raw).use { assertTrue(original.compress(Bitmap.CompressFormat.JPEG,98,it)) }; original.recycle()
            if(index==1) ExifInterface(task.raw).apply { setAttribute(ExifInterface.TAG_ORIENTATION,"6"); saveAttributes() }
            task.stage=Stage.CAPTURED; task.save()
            WatermarkRenderer(context).render(task)
            val expectedHash=fileHash(task.marked)
            val expectedW=if(index==1)height else width; val expectedH=if(index==1)width else height
            assertEquals(expectedW,task.data.getInt("width")); assertEquals(expectedH,task.data.getInt("height"))
            // Simulate exit after the complete marked file is durable: reconstruct from the disk ledger.
            val recovered=store.all().first { it.id==task.id }
            AlbumWriter(context).publish(recovered)
            assertEquals(Stage.SAVED,recovered.stage)
            val uri=android.net.Uri.parse(recovered.data.getString("mediaUri"))
            context.contentResolver.openInputStream(uri)!!.use { stream ->
                val decoded=BitmapFactory.decodeStream(stream)!!
                assertEquals(expectedW,decoded.width); assertEquals(expectedH,decoded.height); decoded.recycle()
            }
            assertEquals(expectedHash,recovered.data.getString("sha256"))
            assertFalse(recovered.raw.exists()); assertFalse(recovered.marked.exists())
            times.add((System.nanoTime()-started)/1_000_000)
        }
        val all=store.all().filter { it.actor.id==actor.id && it.data.optString("session")=="instrumentation" }
        assertTrue(all.size>=20); assertTrue(all.all { it.stage==Stage.SAVED })
        store.schedule(true)
        val manager=androidx.work.WorkManager.getInstance(context)
        val deadline=System.currentTimeMillis()+30000
        while(System.currentTimeMillis()<deadline && manager.getWorkInfosForUniqueWork("chunmo-photo-save").get().any { !it.state.isFinished }) Thread.sleep(200)
        for(task in all) context.contentResolver.query(android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            arrayOf(android.provider.MediaStore.Images.Media._ID),"${android.provider.MediaStore.Images.Media.DISPLAY_NAME}=?",arrayOf(task.filename),null)!!.use {
            assertEquals("Restart must not duplicate a saved task",1,it.count)
        }
        println("EMULATOR_ONLY_20_NATIVE_IMAGE_MS="+times.joinToString(","))
    }
}
