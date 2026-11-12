package cn.chmsj.photo

import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import android.util.AtomicFile
import androidx.work.*
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID

enum class Stage { CAPTURING, CAPTURED, WATERMARKED, INSERTING, PUBLISHING, SAVED, FAILED }
private object LedgerLock
private val ledgerRevision=java.util.concurrent.atomic.AtomicLong()
private data class LedgerEntry(val stage: Stage,val session: String,val captured: Boolean,val snapshot: String?)
private fun entry(data: JSONObject,snapshot: String)=LedgerEntry(Stage.valueOf(data.getString("stage")),data.optString("session"),data.has("captureMs") || data.getString("stage")=="SAVED",if(data.getString("stage")=="SAVED")null else snapshot)
private val ledgerIndex=mutableMapOf<String,LinkedHashMap<String,LedgerEntry>>()
private val normalScheduled=java.util.concurrent.atomic.AtomicBoolean()
private val retryScheduled=java.util.concurrent.atomic.AtomicBoolean()
data class Task(val dir: File, val data: JSONObject) {
    val id: String get() = data.getString("id")
    val actor: Identity get() = Identity.parse(data.getJSONObject("actor"))
    var stage: Stage
        get() = Stage.valueOf(data.getString("stage"))
        set(v) { data.put("stage", v.name) }
    val raw get() = File(dir, "capture.jpg")
    val marked get() = File(dir, "watermarked.jpg")
    val filename get() = "CHUNMO_$id.jpg"
    fun save(): Unit = synchronized(LedgerLock) {
        dir.mkdirs()
        val store = AtomicFile(File(dir, "task.json")); val out = store.startWrite()
        try {
            val snapshot=data.toString(); out.write(snapshot.toByteArray()); store.finishWrite(out)
            ledgerIndex[dir.parentFile!!.absolutePath]?.put(dir.name,entry(data,snapshot))
            ledgerRevision.incrementAndGet()
        }
        catch (e: Throwable) { store.failWrite(out); throw e }
        Unit
    }
}
class QueueStore(val context: Context) {
    val revision: Long get()=ledgerRevision.get()
    val root = File(context.filesDir, "photo-tasks").apply { mkdirs() }
    fun checkWritable() {
        check(root.usableSpace>200L*1024*1024) { "存储空间不足，请释放空间后重试" }
        val probe=File(root,".probe-${UUID.randomUUID()}")
        try { FileOutputStream(probe).use { it.write(1); it.fd.sync() } } finally { probe.delete() }
    }
    private fun index(): LinkedHashMap<String,LedgerEntry> = ledgerIndex.getOrPut(root.absolutePath) {
        linkedMapOf<String,LedgerEntry>().apply {
            root.listFiles()?.filter { it.isDirectory }?.forEach { dir ->
                runCatching { AtomicFile(File(dir,"task.json")).openRead().bufferedReader().use { it.readText() } }
                    .getOrNull()?.let { snapshot -> runCatching { entry(JSONObject(snapshot),snapshot) }.getOrNull()?.let { put(dir.name,it) } }
            }
        }
    }
    private fun read(id: String,e: LedgerEntry): Task? = runCatching {
        val text=e.snapshot ?: AtomicFile(File(root,"$id/task.json")).openRead().bufferedReader().use { it.readText() }
        Task(File(root,id),JSONObject(text))
    }.getOrNull()
    // Full history remains on disk; only explicit history/tests read saved JSON.
    fun all(): List<Task> = synchronized(LedgerLock) { index().mapNotNull { (id,e)->read(id,e) }.sortedBy { it.data.optString("capturedAt") } }
    fun pending(): List<Task> = synchronized(LedgerLock) { index().filterValues { it.stage!=Stage.SAVED }.mapNotNull { (id,e)->read(id,e) }.sortedBy { it.data.optString("capturedAt") } }
    fun statistics(session: String): IntArray = synchronized(LedgerLock) {
        val mine=index().values.filter { it.session==session }
        intArrayOf(mine.count { it.captured },mine.count { it.stage==Stage.SAVED },mine.count { it.stage==Stage.FAILED },index().values.count { it.stage!=Stage.SAVED },mine.size)
    }
    private fun draft(actor: Identity, receipt: JSONObject, session: String): Task {
        check(placeFresh(receipt)) { "地点凭据已过期，请重新定位" }
        check(root.usableSpace > 200L * 1024 * 1024) { "存储空间不足，未开始拍摄" }
        check(index().values.count { it.stage!=Stage.SAVED }<12) { "本机待保存队列已满，请先重试保存" }
        val id = UUID.randomUUID().toString()
        return Task(File(root, id), JSONObject().put("id", id).put("actor", actor.json())
            .put("receipt", JSONObject(receipt.toString())).put("session", session)
            .put("capturedAt", Instant.now().toString()).put("stage", Stage.CAPTURING.name))
    }
    fun create(actor: Identity, receipt: JSONObject, session: String): Task = synchronized(LedgerLock) {
        draft(actor,receipt,session).also { it.save() }
    }
    fun reserve(actor: Identity, receipt: JSONObject, session: String): CaptureReservation = synchronized(LedgerLock) {
        val task=draft(actor,receipt,session); task.dir.mkdirs()
        val handle=RandomAccessFile(File(task.dir,".capture.lock"),"rw")
        try {
            val lock=handle.channel.lock()
            try { task.save(); CaptureReservation(task,handle,lock) }
            catch(e: Throwable) { lock.release(); throw e }
        } catch(e: Throwable) { handle.close(); throw e }
    }
    fun schedule(retry: Boolean = false) {
        val flag=if(retry)retryScheduled else normalScheduled
        if(!flag.compareAndSet(false,true))return
        val request = OneTimeWorkRequestBuilder<PhotoWorker>().setInputData(workDataOf("retry" to retry)).build()
        try {
            val accepted=WorkManager.getInstance(context).enqueueUniqueWork("chunmo-photo-save", ExistingWorkPolicy.APPEND_OR_REPLACE, request).result
            accepted.addListener({ runCatching { accepted.get() }.onFailure { flag.set(false) } },java.util.concurrent.ForkJoinPool.commonPool())
        }
        catch(e: Exception) { flag.set(false); throw e }
    }
}
data class CaptureReservation(val task: Task, val handle: RandomAccessFile, val lock: java.nio.channels.FileLock)
fun fileHash(file: File): String = file.inputStream().use { stream ->
    val digest = MessageDigest.getInstance("SHA-256"); val buffer = ByteArray(64 * 1024)
    while (true) { val n = stream.read(buffer); if (n < 0) break; digest.update(buffer, 0, n) }
    digest.digest().joinToString("") { "%02x".format(it) }
}
/** One durable ledger + deterministic media filename: reconcile an interrupted insert before retry. */
class AlbumWriter(private val context: Context, private val checkpoint: (String) -> Unit = {}) {
    private val resolver = context.contentResolver
    private val collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
    private val path = "Pictures/春茉工地拍照/"
    @Suppress("DEPRECATION")
    private fun find(task: Task): Uri? {
        resolver.query(MediaStore.setIncludePending(collection), arrayOf(MediaStore.Images.Media._ID),
            "${MediaStore.Images.Media.DISPLAY_NAME}=? AND ${MediaStore.Images.Media.RELATIVE_PATH}=?",
            arrayOf(task.filename, path), null)?.use {
            check(it.count <= 1) { "发现多个同任务相册项目，已停止以避免重复，请人工核查" }
            if (it.moveToFirst()) return ContentUris.withAppendedId(collection, it.getLong(0))
        } ?: error("无法核查相册回执，未重复创建照片")
        return null
    }
    private fun pending(uri: Uri): Int? {
        val cursor=resolver.query(uri, arrayOf(MediaStore.Images.Media.IS_PENDING), null, null, null)
            ?: error("无法读取相册发布状态")
        return cursor.use { if(it.moveToFirst()) it.getInt(0) else null }
    }
    private fun matches(uri: Uri, expected: String): Boolean = resolver.openInputStream(uri)?.use { stream ->
        val hash = MessageDigest.getInstance("SHA-256"); val buffer = ByteArray(64 * 1024)
        while (true) { val n = stream.read(buffer); if (n < 0) break; hash.update(buffer, 0, n) }
        hash.digest().joinToString("") { "%02x".format(it) } == expected
    } ?: false
    fun publish(task: Task, retryMissing: Boolean=false) {
        val started=System.nanoTime()
        val expected = task.data.getString("sha256")
        check(task.marked.isFile && fileHash(task.marked) == expected) { "水印文件未完整保存，原文件仍保留" }
        val oldUri = task.data.optString("mediaUri")
        var uri = if (oldUri.isNotBlank()) Uri.parse(oldUri) else find(task)
        if(uri != null && pending(uri) == null) {
            check(retryMissing) { "原相册项目已不存在，私有照片保留；请明确重试后重新核查" }
            uri=find(task); if(uri==null) task.data.remove("mediaUri")
        }
        if (uri != null && pending(uri) == 0) {
            check(matches(uri, expected)) { "已发布照片内容与任务不符，停止自动重试以防重复" }
            finish(task, uri); Performance.record(context,"albumReconcile",(System.nanoTime()-started)/1000000,task.id); return
        }
        if (uri == null) {
            task.stage = Stage.INSERTING; task.save()
            checkpoint("before-insert")
            uri = resolver.insert(collection, ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, task.filename)
                put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
                put(MediaStore.Images.Media.RELATIVE_PATH, path)
                put(MediaStore.Images.Media.DATE_TAKEN, Instant.parse(task.data.getString("capturedAt")).toEpochMilli())
                put(MediaStore.Images.Media.IS_PENDING, 1)
            }) ?: error("系统媒体库未创建照片，请检查权限和空间")
            checkpoint("after-insert")
        }
        task.data.put("mediaUri", uri.toString()); task.stage = Stage.PUBLISHING; task.save()
        resolver.openFileDescriptor(uri, "rwt")?.use { descriptor ->
            FileOutputStream(descriptor.fileDescriptor).use { out -> task.marked.inputStream().use { it.copyTo(out) }; out.flush(); out.fd.sync() }
        } ?: error("无法写入系统相册，照片仍保留")
        check(matches(uri, expected)) { "系统相册写入校验失败，可重试同一任务" }
        val count = resolver.update(uri, ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }, null, null)
        check(count == 1 && pending(uri) == 0 && matches(uri, expected)) { "相册发布未得到明确回执，照片仍保留" }
        checkpoint("after-publish")
        task.data.put("albumMs",(System.nanoTime()-started)/1000000)
        finish(task, uri)
        Performance.record(context,"albumPublish",(System.nanoTime()-started)/1000000,task.id)
    }
    private fun finish(task: Task, uri: Uri) {
        task.data.put("mediaUri", uri.toString()).put("savedAt", Instant.now().toString()).remove("error")
        task.stage = Stage.SAVED; task.save() // Receipt survives process death before temporary cleanup.
        task.raw.delete(); task.marked.delete()
    }
}
class PhotoWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        (if(inputData.getBoolean("retry",false))retryScheduled else normalScheduled).set(false)
        val store = QueueStore(applicationContext)
        RandomAccessFile(File(store.root, ".queue.lock"), "rw").channel.use { channel -> channel.lock().use {
            for (task in store.pending()) {
                if (isStopped) break
                if (task.stage == Stage.SAVED || (task.stage == Stage.FAILED && !inputData.getBoolean("retry", false))) continue
                try {
                    // CameraX writes are protected by this task lock, so a worker cannot race capture.
                    RandomAccessFile(File(task.dir, ".capture.lock"), "rw").channel.use { capture ->
                        val lock = try { capture.tryLock() } catch (_: Exception) { null }
                        if (lock != null) lock.use {
                            check(task.raw.length() > 0 || task.marked.length() > 0) { "拍摄被中断，尚无完整照片文件；请保留任务并重新拍摄" }
                            if (!task.marked.exists()) WatermarkRenderer(applicationContext).render(task)
                            if (!task.data.has("sha256")) { task.data.put("sha256", fileHash(task.marked)); task.save() }
                            AlbumWriter(applicationContext).publish(task,inputData.getBoolean("retry",false))
                        }
                    }
                } catch (e: Throwable) {
                    task.stage = Stage.FAILED
                    task.data.put("error", when(e) {
                        is OutOfMemoryError -> "原像素照片超出当前设备可用内存，原文件已保留；请释放内存后重试"
                        is SecurityException -> "系统拒绝相册访问，私有照片已保留；请检查权限后重试"
                        else -> (e.message ?: e.javaClass.simpleName).take(240)
                    }); task.save()
                }
            }
        } }
        return Result.success()
    }
}
