package cn.chmsj.photo

import android.content.*
import android.database.Cursor
import android.database.MatrixCursor
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import androidx.exifinterface.media.ExifInterface
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowContentResolver
import java.io.*
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class NativeCoreTest {
    private val context get() = RuntimeEnvironment.getApplication()
    private val actor = Identity("synthetic-actor", "synthetic-workspace", "测试监理")
    private fun receipt() = JSONObject().put("placeSource","amap-poi-selected").put("placeName","隔离测试地点")
        .put("token","synthetic-not-a-real-signature").put("poi",JSONObject().put("id","test"))
        .put("expiresAt",Instant.now().plusSeconds(90).toString())
        .put("location",JSONObject().put("latitude",30).put("longitude",120).put("accuracy",12).put("obtainedAt",Instant.now().toString()))
    private fun captured(width: Int=800, height: Int=600, rotation: Int=1): Task {
        val task=QueueStore(context).create(actor,receipt(),"test-session")
        val bitmap=Bitmap.createBitmap(width,height,Bitmap.Config.ARGB_8888).apply { eraseColor(Color.rgb(200,210,190)) }
        FileOutputStream(task.raw).use { bitmap.compress(Bitmap.CompressFormat.JPEG,98,it) }; bitmap.recycle()
        ExifInterface(task.raw).apply { setAttribute(ExifInterface.TAG_ORIENTATION,rotation.toString()); saveAttributes() }
        task.stage=Stage.CAPTURED; task.save(); return task
    }
    @Before fun cleanIsolatedTasks() { File(context.filesDir,"photo-tasks").deleteRecursively() }
    @Test fun locationExpiryAndProviderRules() {
        val p=receipt(); assertTrue(placeFresh(p))
        assertFalse(placeFresh(p,System.currentTimeMillis()+91000))
        p.getJSONObject("location").put("accuracy",101); assertFalse(placeFresh(p))
        p.getJSONObject("location").put("accuracy",12); p.put("placeSource","manual"); assertFalse(placeFresh(p))
    }
    @Test fun watermarkLayoutMatchesWebFixtureAndShanghaiClock() {
        val m=markLayout(4000,3000,"测试现场","2026-11-12T01:02:03Z","测试监理")
        assertEquals(4000f/1100,m.scale,0.0001f)
        assertEquals(16*m.scale,m.x,0.001f)
        assertEquals(780*m.scale,m.width,0.001f)
        assertEquals(3,m.lines.size); assertEquals("拍摄时间：2026.11.12 09:02",m.lines[1])
    }
    @Test fun fullPixelsOrientationAndDurableRecovery() {
        val task=captured(1200,800,6)
        WatermarkRenderer(context).render(task)
        val options=BitmapFactory.Options().apply { inJustDecodeBounds=true }
        BitmapFactory.decodeFile(task.marked.path,options)
        assertEquals(800,options.outWidth); assertEquals(1200,options.outHeight)
        assertEquals(fileHash(task.marked),task.data.getString("sha256"))
        assertTrue(task.raw.exists()); assertEquals(Stage.WATERMARKED,QueueStore(context).all().single().stage)
        val metadata=ExifInterface(task.marked).getAttribute(ExifInterface.TAG_USER_COMMENT)!!
        assertTrue(metadata.contains("amap-poi-selected")); assertFalse(metadata.contains("synthetic-not-a-real-signature"))
    }
    @Test fun twentyQueuedImagesKeepDimensionsAndReceiptBeforeCleanup() {
        val provider=AlbumDouble(context.cacheDir)
        ShadowContentResolver.registerProviderInternal(MediaStore.AUTHORITY,provider)
        val started=System.nanoTime()
        repeat(20) {
            val task=captured(800,600)
            WatermarkRenderer(context).render(task); AlbumWriter(context).publish(task)
            assertEquals(Stage.SAVED,task.stage); assertFalse(task.raw.exists()); assertFalse(task.marked.exists())
        }
        assertEquals(20,provider.inserts)
        assertEquals(20,QueueStore(context).all().count { it.stage==Stage.SAVED })
        provider.rows.values.forEach { assertEquals(0,it.pending); assertTrue(it.file.length()>0) }
        println("Synthetic 20-image processing+provider-double ms="+(System.nanoTime()-started)/1_000_000)
    }
    @Test fun crashAfterPublicationReconcilesWithoutDuplicate() {
        val provider=AlbumDouble(context.cacheDir).apply { crashAfterPublish=true }
        ShadowContentResolver.registerProviderInternal(MediaStore.AUTHORITY,provider)
        val task=captured(); WatermarkRenderer(context).render(task)
        assertThrows(IOException::class.java) { AlbumWriter(context).publish(task) }
        assertTrue(task.marked.exists()); assertEquals(1,provider.inserts)
        val restored=QueueStore(context).all().single()
        AlbumWriter(context).publish(restored)
        assertEquals(1,provider.inserts); assertEquals(Stage.SAVED,restored.stage)
    }
    @Test fun crashDuringInsertFindsDeterministicFilenameBeforeRetry() {
        val provider=AlbumDouble(context.cacheDir).apply { crashAfterInsert=true }
        ShadowContentResolver.registerProviderInternal(MediaStore.AUTHORITY,provider)
        val task=captured(); WatermarkRenderer(context).render(task)
        assertThrows(IOException::class.java) { AlbumWriter(context).publish(task) }
        assertTrue(task.marked.exists()); assertFalse(task.data.has("mediaUri"))
        AlbumWriter(context).publish(QueueStore(context).all().single())
        assertEquals(1,provider.inserts)
    }
    @Test fun permissionAndSpaceFailuresRetainOnlyRecoverableFiles() {
        val provider=AlbumDouble(context.cacheDir).apply { denied=true }
        ShadowContentResolver.registerProviderInternal(MediaStore.AUTHORITY,provider)
        val task=captured(); WatermarkRenderer(context).render(task)
        assertThrows(SecurityException::class.java) { AlbumWriter(context).publish(task) }
        assertTrue(task.raw.exists()); assertTrue(task.marked.exists())
        provider.denied=false; provider.noSpace=true
        assertThrows(IOException::class.java) { AlbumWriter(context).publish(task) }
        assertTrue(task.marked.exists())
        provider.noSpace=false; AlbumWriter(context).publish(task); assertEquals(Stage.SAVED,task.stage)
    }
    @Test fun httpsLoginSessionCsrfAndActorComeFromServer() {
        val vault=MemoryVault(); val requests=mutableListOf<ConnectionDouble>()
        val responses=ArrayDeque(listOf(
            Triple(200,"{\"ok\":true}","chunmo_session="+"a".repeat(64)+"; HttpOnly; Secure"),
            Triple(200,"{\"csrf\":\"csrf-from-server\",\"user\":{\"id\":\"a\",\"workspaceId\":\"w\"}}",null),
            Triple(200,"{\"actorId\":\"a\",\"actorName\":\"服务器姓名\"}",null),
            Triple(200,"{\"places\":[]}",null)))
        val api=Api(vault) { url -> val (code,body,cookie)=responses.removeFirst(); ConnectionDouble(url,code,body,cookie).also { requests.add(it) } }
        api.login("existing","not-stored-password")
        assertEquals("服务器姓名",api.identity!!.name)
        api.call("/api/site-photos/location",JSONObject().put("nearby",true))
        assertEquals("csrf-from-server",requests.last().getRequestProperty("X-CSRF-Token"))
        assertEquals("https://chmsj.cn",requests.first().getRequestProperty("Origin"))
        assertTrue(requests.last().getRequestProperty("Cookie").startsWith("chunmo_session="))
        assertFalse(vault.value.toString().contains("not-stored-password"))
        assertThrows(IllegalArgumentException::class.java) { api.setOrigin("http://chmsj.cn") }
        assertThrows(IllegalArgumentException::class.java) { api.setOrigin("https://name:password@chmsj.cn") }
    }
    @Test fun loginFailureDoesNotCreateIdentityOrPersistPassword() {
        val vault=MemoryVault(); val api=Api(vault) { ConnectionDouble(it,401,"{\"error\":\"账号或密码不正确\"}",null) }
        assertThrows(IllegalStateException::class.java) { api.login("test","bad") }
        assertNull(api.identity); assertNull(vault.value)
    }
}
class MemoryVault : SessionStorage {
    var value: JSONObject?=null
    override fun read()=value
    override fun save(data: JSONObject) { value=data }
    override fun clear() { value=null }
}
class ConnectionDouble(url: URL, private val code: Int, private val text: String, private val cookie: String?) : HttpURLConnection(url) {
    val body=ByteArrayOutputStream()
    override fun connect() { }; override fun disconnect() { }; override fun usingProxy()=false
    override fun getResponseCode()=code
    override fun getInputStream()=ByteArrayInputStream(text.toByteArray())
    override fun getErrorStream()=ByteArrayInputStream(text.toByteArray())
    override fun getOutputStream()=body
    override fun getHeaderFields(): MutableMap<String,MutableList<String>> = mutableMapOf<String,MutableList<String>>().apply { if(cookie!=null) put("Set-Cookie",mutableListOf(cookie)) }
}
class AlbumDouble(private val directory: File) : ContentProvider() {
    data class Row(val name: String,val file: File,var pending: Int=1)
    val rows=linkedMapOf<Long,Row>(); var inserts=0; var denied=false; var noSpace=false
    var crashAfterPublish=false; var crashAfterInsert=false
    override fun onCreate()=true
    override fun getType(uri: Uri)="image/jpeg"
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, order: String?): Cursor {
        val c=MatrixCursor(projection ?: arrayOf("_id"))
        if(selection!=null) rows.filterValues { it.name==args?.firstOrNull() }.forEach { c.addRow(arrayOf(it.key)) }
        else rows[uri.lastPathSegment?.toLongOrNull()]?.let { c.addRow(arrayOf(it.pending)) }
        return c
    }
    override fun insert(uri: Uri, values: ContentValues?): Uri {
        if(denied) throw SecurityException("denied")
        if(noSpace) throw IOException("No space left on device")
        inserts++; val id=inserts.toLong()
        rows[id]=Row(values!!.getAsString(MediaStore.Images.Media.DISPLAY_NAME),File(directory,"provider-$id.jpg"))
        if(crashAfterInsert) { crashAfterInsert=false; throw IOException("simulated process interruption after insert") }
        return Uri.withAppendedPath(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,id.toString())
    }
    override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?): Int {
        rows.getValue(uri.lastPathSegment!!.toLong()).pending=values!!.getAsInteger(MediaStore.Images.Media.IS_PENDING)
        if(crashAfterPublish) { crashAfterPublish=false; throw IOException("simulated interruption after system publication") }
        return 1
    }
    override fun delete(uri: Uri, selection: String?, args: Array<out String>?)=0
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val f=rows.getValue(uri.lastPathSegment!!.toLong()).file
        return ParcelFileDescriptor.open(f,if(mode=="r") ParcelFileDescriptor.MODE_READ_ONLY else ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE or ParcelFileDescriptor.MODE_READ_WRITE)
    }
}
