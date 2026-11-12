package cn.chmsj.photo

import android.Manifest
import android.content.res.Configuration
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.*
import android.widget.*
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.*
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.RandomAccessFile
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Executors

class MainActivity : ComponentActivity() {
    private lateinit var api: Api
    private lateinit var store: QueueStore
    private lateinit var page: LinearLayout
    private lateinit var message: TextView
    private var screen = "login"
    private var place: JSONObject? = null
    private var location: JSONObject? = null
    private var selected: JSONObject? = null
    private var session = UUID.randomUUID().toString()
    private var provider: ProcessCameraProvider? = null
    private var previewUseCase: Preview? = null
    private var camera: ImageCapture? = null
    private var markView: WatermarkView? = null
    private var countView: TextView? = null
    private var recoveryView: TextView? = null
    private var shutter: Button? = null
    private var inFlight = false
    private var renewing = false
    private var active = false
    private var pageVersion = 0
    private var counts = intArrayOf(0,0,0,0)
    private val captureExecutor = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    private var permissionAction: (() -> Unit)? = null
    private val permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        if (result.values.all { it }) permissionAction?.invoke() else tell("权限未获准；请在系统设置允许相机和精确定位")
        permissionAction = null
    }
    private val pulse = object : Runnable {
        override fun run() {
            if (!active) return
            markView?.let { it.at = Instant.now().toString(); it.invalidate() }
            if (screen == "camera") {
                updateFrame()
                val receipt = place
                if (receipt != null && !renewing && System.currentTimeMillis()-Instant.parse(receipt.getJSONObject("location").getString("obtainedAt")).toEpochMilli() > 45000) renew()
                shutter?.isEnabled = !inFlight && counts[3] < 12 && api.identity != null && receipt != null && placeFresh(receipt)
            }
            lifecycleScope.launch {
                val all = withContext(Dispatchers.IO) { store.all() }
                val tasks=all.filter { it.data.optString("session") == session }
                val actor=api.identity
                if(actor!=null) {
                    val backlog=all.filter { it.actor.id==actor.id && it.actor.workspace==actor.workspace && it.stage!=Stage.SAVED }
                    recoveryView?.text="待保存 ${backlog.count { it.stage!=Stage.FAILED }} · 失败 ${backlog.count { it.stage==Stage.FAILED }}"
                }
                val oldFailed=counts[2]
                counts = intArrayOf(tasks.count { it.data.has("captureMs") || it.stage == Stage.SAVED }, tasks.count { it.stage == Stage.SAVED }, tasks.count { it.stage == Stage.FAILED }, tasks.count { it.stage !in listOf(Stage.SAVED,Stage.FAILED) })
                countView?.text = "已拍 ${counts[0]} · 已存 ${counts[1]} · 失败 ${counts[2]}"
                if(counts[2]>oldFailed) tell(tasks.lastOrNull { it.stage==Stage.FAILED }?.data?.optString("error") ?: "相册保存失败，照片仍保留，可重试")
            }
            handler.postDelayed(this, 1000)
        }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        api = Api(SessionVault(this)); store = QueueStore(applicationContext)
        store.schedule() // Existing captures are local save work, never new server requests.
        loginPage()
        if(api.hasSession) launchIO({ api.resume() }) { placesPage() }
    }
    override fun onStart() { super.onStart(); active = true; handler.post(pulse) }
    override fun onStop() { active = false; handler.removeCallbacks(pulse); super.onStop() }
    override fun onDestroy() { provider?.unbindAll(); captureExecutor.shutdown(); super.onDestroy() }
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        if (screen == "camera") cameraPage(false)
    }
    private fun dp(n: Int) = (n*resources.displayMetrics.density).toInt()
    private fun text(value: String, size: Float=16f) = TextView(this).apply { text=value; textSize=size; setTextColor(Color.rgb(40,78,61)); setPadding(dp(8),dp(8),dp(8),dp(8)) }
    private fun base(title: String) {
        pageVersion++; markView=null; shutter=null; countView=null; recoveryView=null
        androidx.core.view.WindowCompat.getInsetsController(window,window.decorView).show(androidx.core.view.WindowInsetsCompat.Type.systemBars())
        page = LinearLayout(this).apply { orientation=LinearLayout.VERTICAL; setPadding(dp(12),dp(16),dp(12),dp(12)); setBackgroundColor(Color.rgb(249,250,244)) }
        message = text("")
        val scroll = ScrollView(this).apply { addView(page) }; setContentView(scroll)
        page.addView(text(title,22f)); page.addView(message)
    }
    private fun button(label: String, parent: LinearLayout=page, action: () -> Unit): Button = Button(this).apply {
        text=label; setOnClickListener { action() }; parent.addView(this)
    }
    private fun tell(s: String) { message.text=s }
    private fun <T> launchIO(work: () -> T, done: (T) -> Unit) {
        val version = pageVersion
        lifecycleScope.launch {
            try { val value = withContext(Dispatchers.IO) { work() }; if (version == pageVersion) done(value) }
            catch(e: Exception) { if (version == pageVersion) tell(e.message ?: "操作失败，请重试") }
        }
    }
    private fun allow(action: () -> Unit) {
        val required = arrayOf(Manifest.permission.CAMERA, Manifest.permission.ACCESS_FINE_LOCATION,Manifest.permission.ACCESS_COARSE_LOCATION)
        if (required.all { ContextCompat.checkSelfPermission(this,it) == android.content.pm.PackageManager.PERMISSION_GRANTED }) action()
        else { permissionAction=action; permissions.launch(required) }
    }
    private fun loginPage() {
        screen="login"; base("春茉工地拍照")
        val origin = EditText(this).apply { hint="系统HTTPS地址"; setText(api.origin); inputType=InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI }
        val name = EditText(this).apply { hint="现有账号"; isSingleLine=true }
        val password = EditText(this).apply { hint="密码"; inputType=InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
        page.addView(origin); page.addView(name); page.addView(password)
        button("登录") {
            pageVersion++ // A delayed automatic session response cannot replace this explicit login.
            val account=name.text.toString(); val secret=password.text.toString()
            try { api.setOrigin(origin.text.toString()) } catch(e: Exception) { tell(e.message ?: "地址无效"); return@button }
            tell("正在登录…")
            password.text.clear()
            launchIO({ api.login(account,secret) }) { password.text.clear(); placesPage() }
        }
        button("重试本机未保存照片") { store.schedule(true); tell("已请求重试；仅处理本机之前拍摄的文件，不创建新照片") }
    }
    private fun placesPage() {
        provider?.unbindAll(); camera=null; screen="places"; place=null; selected=null; base("选择拍摄地点")
        recoveryView=text("正在读取本机待保存记录…"); page.addView(recoveryView)
        val query = EditText(this).apply { hint="搜索2公里内地点"; isSingleLine=true }; page.addView(query)
        val list=LinearLayout(this).apply { orientation=LinearLayout.VERTICAL }; page.addView(list)
        var pageNumber=1
        fun search(fresh: Boolean) {
            val version=pageVersion
            lifecycleScope.launch {
                try {
                    tell("正在定位和查询…")
                    if (fresh || location == null || !locationFresh(location!!)) { location=Gps(this@MainActivity).locate(); pageNumber=1; list.removeAllViews(); selected=null }
                    val point=location!!
                    val result=withContext(Dispatchers.IO) { api.call("/api/site-photos/location",JSONObject().put("location",point).put("nearby",true).put("query",query.text.toString()).put("page",pageNumber)) }
                    if (version != pageVersion) return@launch
                    val places=result.getJSONArray("places")
                    for (i in 0 until places.length()) {
                        val p=places.getJSONObject(i); val receipt=p.getJSONObject("receipt")
                        if (!placeFresh(receipt)) continue
                        if (selected == null) selected=receipt
                        button("${p.getString("name")} · ${p.getInt("distance")}米",list) { selected=receipt; tell("已选：${receipt.getString("placeName")}") }
                    }
                    pageNumber++; tell(if (selected == null) "无可选地点，请重新定位或搜索" else "已选：${selected!!.getString("placeName")}")
                } catch(e: Exception) { if (version == pageVersion) tell(e.message ?: "定位失败，请重试") }
            }
        }
        button("搜索 / 重新定位") { allow { search(true) } }
        button("加载更多") { allow { search(false) } }
        button("确认地点并拍摄") {
            val p=selected
            if (p == null || !placeFresh(p)) { tell("请选择有效地点，过期请重新定位"); return@button }
            place=p; session=UUID.randomUUID().toString(); allow { cameraPage(true) }
        }
        button("重试未保存照片") { store.schedule(true); tell("正在后台重试，未保存文件保留") }
        button("退出账号") { launchIO({ api.logout() }) { revoked -> loginPage(); if(!revoked) tell("已退出本机，服务器会话撤销未获确认") } }
        allow { search(true) }
    }
    private fun renew() {
        val previous=place ?: return
        renewing=true
        lifecycleScope.launch {
            try {
                val gps=Gps(this@MainActivity).locate()
                val next=withContext(Dispatchers.IO) { api.call("/api/site-photos/place",JSONObject().put("location",gps).put("previousToken",previous.getString("token")).put("previousAt",previous.getString("resolvedAt"))) }
                if (place === previous) place=next
            } catch(e: Exception) { if (screen == "camera") tell("定位更新失败，过期将暂停快门：${e.message}") }
            finally { renewing=false }
        }
    }
    private fun cameraPage(bind: Boolean) {
        pageVersion++; screen="camera"; recoveryView=null
        val root=FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        val view=PreviewView(this).apply { scaleType=PreviewView.ScaleType.FIT_CENTER; implementationMode=PreviewView.ImplementationMode.COMPATIBLE }
        root.addView(view,FrameLayout.LayoutParams(-1,-1))
        val mark=WatermarkView(this).apply { place=this@MainActivity.place?.optString("placeName") ?: ""; actor=api.identity?.name ?: "" }
        markView=mark; root.addView(mark,FrameLayout.LayoutParams(-1,-1))
        val top=LinearLayout(this).apply { orientation=LinearLayout.VERTICAL; setPadding(dp(16),dp(24),dp(16),dp(8)); setBackgroundColor(0x66152c23) }
        top.addView(text(place?.optString("placeName") ?: "").apply { setTextColor(Color.WHITE) })
        message=text("").apply { setTextColor(Color.WHITE) }; top.addView(message)
        root.addView(top,FrameLayout.LayoutParams(-1,-2,Gravity.TOP))
        val bottom=LinearLayout(this).apply { orientation=LinearLayout.VERTICAL; gravity=Gravity.CENTER; setPadding(dp(8),dp(8),dp(8),dp(24)); setBackgroundColor(0x99152c23.toInt()) }
        countView=text("").apply { setTextColor(Color.WHITE) }; bottom.addView(countView)
        val row=LinearLayout(this).apply { gravity=Gravity.CENTER }; bottom.addView(row)
        shutter=button("● 拍照",row) { capture() }
        button("完成",row) { if(inFlight) tell("照片正在捕获，请稍候") else { provider?.unbindAll(); camera=null; placesPage() } }
        button("重试失败",row) { store.schedule(true); tell("正在重试本机保存") }
        root.addView(bottom,FrameLayout.LayoutParams(-1,-2,Gravity.BOTTOM))
        setContentView(root)
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val safe=insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.displayCutout())
            v.setPadding(safe.left,safe.top,safe.right,safe.bottom); insets
        }
        androidx.core.view.WindowCompat.getInsetsController(window,window.decorView).hide(androidx.core.view.WindowInsetsCompat.Type.systemBars())
        if (!bind && previewUseCase != null && camera != null) { previewUseCase!!.setSurfaceProvider(view.surfaceProvider); updateFrame(); return }
        val future=ProcessCameraProvider.getInstance(this)
        val cameraVersion=pageVersion
        future.addListener({
            try {
                if (screen != "camera" || pageVersion!=cameraVersion) return@addListener
                provider=future.get()
                val ratio=ResolutionSelector.Builder().setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY).build()
                previewUseCase=Preview.Builder().setResolutionSelector(ratio).build().also { it.setSurfaceProvider(view.surfaceProvider) }
                camera=ImageCapture.Builder().setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
                    .setJpegQuality(98).setResolutionSelector(ResolutionSelector.Builder().setAllowedResolutionMode(ResolutionSelector.PREFER_HIGHER_RESOLUTION_OVER_CAPTURE_RATE)
                        .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY).build()).build()
                provider!!.unbindAll(); provider!!.bindToLifecycle(this,CameraSelector.DEFAULT_BACK_CAMERA,previewUseCase,camera)
                updateFrame()
            } catch(e: Exception) { tell("相机开启失败：${e.message}") }
        },ContextCompat.getMainExecutor(this))
    }
    private fun updateFrame() {
        @Suppress("DEPRECATION")
        val rotation = windowManager.defaultDisplay.rotation
        if(camera?.targetRotation!=rotation) camera?.targetRotation=rotation
        val info=camera?.resolutionInfo ?: return
        markView?.let {
            val rotated=info.rotationDegrees % 180 != 0
            it.photoWidth=if(rotated) info.resolution.height else info.resolution.width
            it.photoHeight=if(rotated) info.resolution.width else info.resolution.height; it.invalidate()
        }
    }
    private fun capture() {
        val output=camera ?: return; val actor=api.identity ?: return; val receipt=place ?: return
        if(inFlight || counts[3]>=12) { tell("照片正在处理，请稍后继续"); return }
        if(!placeFresh(receipt)) { tell("定位凭据过期，正在更新"); renew(); return }
        inFlight=true; shutter?.isEnabled=false; updateFrame()
        try {
            val task=store.create(actor,receipt,session)
            val handle=RandomAccessFile(java.io.File(task.dir,".capture.lock"),"rw"); val lock=handle.channel.lock()
            val started=System.nanoTime()
            output.takePicture(ImageCapture.OutputFileOptions.Builder(task.raw).build(),captureExecutor,object: ImageCapture.OnImageSavedCallback {
                override fun onCaptureStarted() { task.data.put("capturedAt",Instant.now().toString()); task.save() }
                override fun onImageSaved(result: ImageCapture.OutputFileResults) {
                    try {
                        RandomAccessFile(task.raw,"rw").use { it.fd.sync() }
                        task.stage=Stage.CAPTURED; task.data.put("captureMs",(System.nanoTime()-started)/1_000_000); task.save()
                    } catch(e: Exception) { task.stage=Stage.FAILED; task.data.put("error",e.message); task.save() }
                    finally { lock.release(); handle.close(); store.schedule(); runOnUiThread { inFlight=false; shutter?.isEnabled=true } }
                }
                override fun onError(exception: ImageCaptureException) {
                    task.stage=Stage.FAILED; task.data.put("error",exception.message); task.save()
                    lock.release(); handle.close(); runOnUiThread { inFlight=false; tell("拍摄失败，任务与已有文件保留：${exception.message}") }
                }
            })
        } catch(e: Exception) { inFlight=false; tell(e.message ?: "拍摄失败，请重试") }
    }
}
