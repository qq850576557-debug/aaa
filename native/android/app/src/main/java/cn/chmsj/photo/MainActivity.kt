package cn.chmsj.photo

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.text.Editable
import android.text.TextWatcher
import android.view.*
import android.view.inputmethod.EditorInfo
import android.widget.*
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.*
import androidx.camera.core.resolutionselector.*
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.core.view.*
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Executors

@androidx.annotation.OptIn(markerClass = [ExperimentalZeroShutterLag::class])
class MainActivity : ComponentActivity() {
    private lateinit var api: Api
    private lateinit var store: QueueStore
    private lateinit var ui: BrandUi
    private lateinit var page: LinearLayout
    private lateinit var message: TextView
    private var screen="login"
    private var place: JSONObject?=null
    private var location: JSONObject?=null
    private var selected: JSONObject?=null
    private val choices=mutableListOf<JSONObject>()
    private var session=UUID.randomUUID().toString()
    private var provider: ProcessCameraProvider?=null
    private var previewUseCase: Preview?=null
    private var camera: ImageCapture?=null
    private var markView: WatermarkView?=null
    private var countView: TextView?=null
    private var recoveryView: TextView?=null
    private var shutter: Button?=null
    private var queryView: EditText?=null
    private var listView: LinearLayout?=null
    private var locationLabel: TextView?=null
    private var confirm: Button?=null
    private var more: Button?=null
    private var pageNumber=1
    private var moreAvailable=true
    private var searchJob: Job?=null
    private var searchGeneration=0
    private var renewing=false
    private var captureStorageFault=false
    private var active=false
    private var polling=false
    private var pageVersion=0
    private var lastRevision=-1L
    private var lastPoll=0L
    private var lastMinute=-1L
    private var counts=intArrayOf(0,0,0,0)
    private val gate=CaptureGate(3)
    private val captureExecutor=Executors.newSingleThreadExecutor()
    private val handler=Handler(Looper.getMainLooper())
    private val started=System.nanoTime()
    private var cameraOpened=0L
    private var cameraReady=false
    private var frameStats: NativeFrames?=null
    private var permissionAction: (() -> Unit)?=null
    private val permissions=registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        val action=permissionAction; permissionAction=null
        if(result.isNotEmpty() && result.values.all { it }) action?.invoke()
        else tell("权限未获准，请在系统设置允许相机或精确定位后重试")
    }
    private val pulse=object: Runnable {
        override fun run() {
            if(!active)return
            val minute=System.currentTimeMillis()/60000
            if(minute!=lastMinute) { lastMinute=minute; markView?.let { it.at=Instant.now().toString(); it.invalidate() } }
            if(screen=="camera") {
                updateFrame()
                place?.let { if(!renewing && System.currentTimeMillis()-Instant.parse(it.getJSONObject("location").getString("obtainedAt")).toEpochMilli()>45000)renew() }
                updateShutter()
            }
            if(!polling && (lastRevision!=store.revision || System.currentTimeMillis()-lastPoll>5000)) {
                polling=true; lastRevision=store.revision; lastPoll=System.currentTimeMillis()
                lifecycleScope.launch {
                    try {
                        counts=withContext(Dispatchers.IO) { store.statistics(session) }
                        countView?.text="已拍 ${counts[0]}  ·  已存 ${counts[1]}  ·  失败 ${counts[2]}"
                        recoveryView?.text=if(counts[3]>0)"本机待保存 ${counts[3]} 张 · 点击重试" else ""
                        updateShutter()
                    } finally { polling=false }
                }
            }
            handler.postDelayed(this,1000)
        }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ui=BrandUi(this); api=Api(SessionVault(this)); store=QueueStore(applicationContext); frameStats=NativeFrames(applicationContext,window)
        WindowCompat.setDecorFitsSystemWindows(window,false)
        store.schedule(); captureExecutor.execute { WatermarkRenderer(applicationContext).prepare() }; loginPage()
        onBackPressedDispatcher.addCallback(this,object: OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when(screen) { "camera"->finishCamera(); "settings"->if(api.identity!=null)placesPage(false) else loginPage(); "places"->android.app.AlertDialog.Builder(this@MainActivity).setMessage("退出拍摄界面？本机待保存照片仍会保留。").setNegativeButton("取消",null).setPositiveButton("退出") { _,_->finish() }.show(); else->finish() }
            }
        })
        if(api.hasSession) launchIO({ api.resume() }) { placesPage() }
    }
    override fun onStart() { super.onStart(); active=true; handler.post(pulse) }
    override fun onStop() { active=false; handler.removeCallbacks(pulse); super.onStop() }
    override fun onDestroy() { provider?.unbindAll(); frameStats?.close(); if(gate.pending()==0)captureExecutor.shutdown(); super.onDestroy() }
    override fun onConfigurationChanged(newConfig: Configuration) { super.onConfigurationChanged(newConfig); if(screen=="camera")cameraPage(false) }
    private fun dp(n: Int)=ui.dp(n)
    private fun tell(value: String) { message.text=value; message.visibility=if(value.isEmpty())View.GONE else View.VISIBLE }
    private fun friendly(e: Exception): String = when(e) {
        is java.net.SocketTimeoutException, is TimeoutCancellationException -> "请求超时，请检查网络或定位后重试"
        is java.io.IOException -> "网络或本机存储暂不可用，请重试；已有照片保留"
        is SecurityException -> "系统权限未获准，请检查授权后重试"
        else -> e.message?.takeIf { it.length<90 && !it.contains("HTTP") && !it.contains("Exception") && !it.contains("{ ") } ?: "操作未完成，请重试"
    }
    private fun <T> launchIO(work: ()->T, done: (T)->Unit) {
        val version=pageVersion
        lifecycleScope.launch {
            try { val result=withContext(Dispatchers.IO) { work() }; if(version==pageVersion)done(result) }
            catch(e: CancellationException) { throw e }
            catch(e: Exception) { if(version==pageVersion)tell(friendly(e)) }
        }
    }
    private fun allow(required: Array<String>, action: ()->Unit) {
        if(required.all { ContextCompat.checkSelfPermission(this,it)==PackageManager.PERMISSION_GRANTED })action()
        else { permissionAction=action; permissions.launch(required) }
    }
    private fun safe(root: View, cameraMode: Boolean=false) {
        val bars=WindowInsetsCompat.Type.systemBars()
        val controller=WindowCompat.getInsetsController(window,window.decorView)
        if(cameraMode) { controller.hide(bars); controller.systemBarsBehavior=WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE }
        else { controller.show(bars); controller.isAppearanceLightStatusBars=true }
        ViewCompat.setOnApplyWindowInsetsListener(root) { v,insets ->
            val cut=insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or if(cameraMode)0 else WindowInsetsCompat.Type.ime())
            v.setPadding(if(cameraMode)cut.left else cut.left+dp(18),cut.top,if(cameraMode)cut.right else cut.right+dp(18),cut.bottom)
            insets
        }
        ViewCompat.requestApplyInsets(root)
    }
    private fun base(title: String, back: Boolean=true) {
        pageVersion++; markView=null; countView=null; shutter=null; recoveryView=null
        page=ui.column(); page.setBackgroundColor(ui.background); setContentView(page); safe(page)
        val header=ui.row(); header.minimumHeight=dp(58)
        if(back)header.addView(ui.button("‹") { onBackPressedDispatcher.onBackPressed() },LinearLayout.LayoutParams(dp(48),dp(44)))
        header.addView(ui.label(title,20f).apply { setTypeface(null,android.graphics.Typeface.BOLD); setPadding(dp(8),0,0,0) },LinearLayout.LayoutParams(0,-2,1f))
        if(screen!="settings")header.addView(ui.button("设置") { settingsPage() },LinearLayout.LayoutParams(-2,dp(44)))
        ui.full(page,header)
        message=ui.label("",13f,ui.muted).apply { setPadding(dp(4),dp(8),dp(4),dp(8)); visibility=View.GONE }
        ui.full(page,message)
    }
    private fun loginPage() {
        screen="login"; base("",false)
        val scroll=ScrollView(this).apply { isFillViewport=true; isVerticalScrollBarEnabled=false }
        page.addView(scroll,LinearLayout.LayoutParams(-1,0,1f))
        val center=ui.column().apply { gravity=Gravity.CENTER }
        scroll.addView(center,FrameLayout.LayoutParams(-1,-1))
        val card=ui.column(22).apply { background=ui.shape(Color.WHITE,22,ui.edge) }
        center.addView(card,LinearLayout.LayoutParams(-1,-2)); ui.gap(center,24)
        val hero=ui.column(22).apply { gravity=Gravity.CENTER; background=ui.shape(ui.green,16) }
        val logo=ImageView(this).apply { setImageResource(R.drawable.chunmo_original); scaleType=ImageView.ScaleType.FIT_CENTER; clipToOutline=true; background=ui.shape(ui.green,48) }
        hero.addView(logo,LinearLayout.LayoutParams(dp(64),dp(64)))
        val title=ui.row().apply { gravity=Gravity.CENTER }
        title.addView(CameraGlyph(this),LinearLayout.LayoutParams(dp(24),dp(24)))
        title.addView(ui.label("  春茉工地拍照",21f,Color.WHITE).apply { setTypeface(null,android.graphics.Typeface.BOLD) })
        hero.addView(title); ui.gap(hero,4); ui.full(card,hero); ui.gap(card,24)
        ui.full(card,ui.label("员工账号",13f,ui.muted)); ui.gap(card,8)
        val account=ui.field("输入员工账号").apply { inputType=InputType.TYPE_CLASS_TEXT; importantForAutofill=View.IMPORTANT_FOR_AUTOFILL_YES; setAutofillHints(View.AUTOFILL_HINT_USERNAME) }
        ui.full(card,account); ui.gap(card,16); ui.full(card,ui.label("登录密码",13f,ui.muted)); ui.gap(card,8)
        val password=ui.field("输入密码").apply { inputType=InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD; imeOptions=EditorInfo.IME_ACTION_DONE; setAutofillHints(View.AUTOFILL_HINT_PASSWORD) }
        ui.full(card,password); ui.gap(card,24)
        val login=ui.button("登录",true) {
            if(account.text.isBlank() || password.text.isBlank()) { tell("请输入员工账号和密码"); return@button }
            pageVersion++; val version=pageVersion; val secret=password.text.toString(); val loginName=account.text.toString().trim(); password.text.clear(); tell("正在登录")
            lifecycleScope.launch {
                try { withContext(Dispatchers.IO) { api.login(loginName,secret) }; if(version==pageVersion)placesPage() }
                catch(e: Exception) { if(version==pageVersion)tell(if(e is java.io.IOException)"网络连接失败，请重试" else "登录失败，请核对账号、密码或账号权限") }
            }
        }
        ui.full(card,login,50)
        password.setOnEditorActionListener { _,action,_-> if(action==EditorInfo.IME_ACTION_DONE) { login.performClick(); true } else false }
    }
    private fun placesPage(locate: Boolean=true) {
        searchJob?.cancel(); provider?.unbindAll(); camera=null; screen="places"; place=null; base("选择拍摄地点")
        val search=ui.row()
        queryView=ui.field("搜索附近地点").apply { imeOptions=EditorInfo.IME_ACTION_SEARCH }
        search.addView(queryView,LinearLayout.LayoutParams(0,dp(48),1f)); search.addView(ui.button("搜索") { searchPlaces(true,false) })
        ui.full(page,search); ui.gap(page,12)
        val status=ui.row()
        locationLabel=ui.label("正在获取实时定位",13f,ui.muted)
        status.addView(locationLabel,LinearLayout.LayoutParams(0,-2,1f)); status.addView(ui.button("重新定位") { searchPlaces(true,true) })
        ui.full(page,status); ui.gap(page,8)
        val scroll=ScrollView(this).apply { isFillViewport=true }
        listView=ui.column(); scroll.addView(listView)
        page.addView(scroll,LinearLayout.LayoutParams(-1,0,1f))
        more=ui.button("加载更多") { searchPlaces(false,false) }; ui.full(listView!!,more!!)
        recoveryView=ui.label("",12f,ui.muted).apply { setPadding(0,dp(6),0,dp(6)); setOnClickListener { store.schedule(true); tell("已请求重试，本机照片保留") } }
        ui.full(page,recoveryView!!)
        confirm=ui.button("确认地点并拍摄",true) {
            val receipt=selected
            if(receipt==null || !placeFresh(receipt)) { tell("地点已过期，请重新定位"); return@button }
            allow(arrayOf(Manifest.permission.CAMERA)) { place=receipt; session=UUID.randomUUID().toString(); counts=intArrayOf(0,0,0,counts[3]); cameraPage(true) }
        }
        ui.full(page,confirm!!,52); ui.gap(page,12)
        queryView!!.setOnEditorActionListener { _,action,_->if(action==EditorInfo.IME_ACTION_SEARCH) { searchPlaces(true,false); true } else false }
        if(locate || choices.isEmpty())searchPlaces(true,true) else {
            locationLabel?.text=if(location?.let { locationFresh(it) }==true)"实时定位 · 精度约±${location!!.getDouble("accuracy").toInt()}米" else "地点已过期，请重新定位"
            renderPlaces()
        }
    }
    private fun renderPlaces() {
        val list=listView ?: return; list.removeAllViews()
        choices.sortedBy { it.optDouble("distance",Double.MAX_VALUE) }.forEach { value ->
            val receipt=value.getJSONObject("receipt"); val checked=selected?.getJSONObject("poi")?.getString("id")==receipt.getJSONObject("poi").getString("id")
            val card=ui.row().apply { setPadding(dp(15),dp(16),dp(15),dp(16)); background=ui.shape(if(checked)0xffeaf2e9.toInt() else Color.WHITE,14,if(checked)ui.green else ui.edge); isFocusable=true; contentDescription="${value.getString("name")}${if(checked)"，已选中" else ""}" }
            val copy=ui.column(); ui.full(copy,ui.label(value.getString("name"),17f).apply { setTypeface(null,android.graphics.Typeface.BOLD) }); ui.gap(copy,8)
            ui.full(copy,ui.label("${value.optInt("distance")}米  ${value.optString("address")}",12f,ui.muted))
            card.addView(copy,LinearLayout.LayoutParams(0,-2,1f)); card.addView(ui.label(if(checked)"✓" else "",23f,ui.green))
            card.setOnClickListener { selected=receipt; renderPlaces() }; ui.full(list,card); ui.gap(list,10)
        }
        more=ui.button(if(moreAvailable)"加载更多" else "已显示全部地点") { searchPlaces(false,false) }.apply { isEnabled=moreAvailable }
        ui.full(list,more!!); confirm?.isEnabled=selected?.let { placeFresh(it) }==true
    }
    private fun searchPlaces(reset: Boolean, relocate: Boolean) {
        if(screen!="places")return
        allow(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION,Manifest.permission.ACCESS_COARSE_LOCATION)) {
            searchJob?.cancel(); val generation=++searchGeneration; val version=pageVersion; val query=queryView?.text.toString()
            if(reset) { pageNumber=1; selected=null; choices.clear(); renderPlaces() }
            val requestedPage=pageNumber
            searchJob=lifecycleScope.launch {
                try {
                    locationLabel?.text="正在获取有效定位与附近地点"; confirm?.isEnabled=false; more?.isEnabled=false
                    if(relocate || location==null || !locationFresh(location!!))location=Gps(this@MainActivity).locate()
                    val point=JSONObject(location.toString())
                    val result=withContext(Dispatchers.IO) { api.call("/api/site-photos/location",JSONObject().put("location",point).put("nearby",true).put("query",query).put("page",requestedPage)) }
                    if(version!=pageVersion || generation!=searchGeneration)return@launch
                    val incoming=result.getJSONArray("places")
                    for(i in 0 until incoming.length()) { val next=incoming.getJSONObject(i); if(placeFresh(next.getJSONObject("receipt")) && choices.none { it.getString("id")==next.getString("id") })choices.add(next) }
                    choices.sortBy { it.optDouble("distance",Double.MAX_VALUE) }; if(selected==null)selected=choices.firstOrNull()?.getJSONObject("receipt")
                    moreAvailable=result.optBoolean("more",false); pageNumber=requestedPage+1
                    locationLabel?.text="实时定位 · 精度约±${point.getDouble("accuracy").toInt()}米"
                    tell(if(choices.isEmpty())"2公里内无有效高德地点，请重新定位或搜索" else ""); renderPlaces()
                } catch(e: CancellationException) { throw e }
                catch(e: Exception) { if(version==pageVersion && generation==searchGeneration) { locationLabel?.text="定位或查询未完成"; tell(friendly(e)); more?.isEnabled=true } }
            }
        }
    }
    private fun renew() {
        val previous=place ?: return; renewing=true
        lifecycleScope.launch {
            try { val gps=Gps(this@MainActivity).locate(); val next=withContext(Dispatchers.IO) { api.call("/api/site-photos/place",JSONObject().put("location",gps).put("previousToken",previous.getString("token")).put("previousAt",previous.getString("resolvedAt"))) }; if(place===previous)place=next }
            catch(e: Exception) { if(screen=="camera")tell("定位更新未完成，过期后暂停快门") }
            finally { renewing=false }
        }
    }
    private fun cameraPage(bind: Boolean) {
        if(bind)frameStats?.start()
        pageVersion++; screen="camera"; recoveryView=null
        val root=FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        val landscape=resources.configuration.orientation==Configuration.ORIENTATION_LANDSCAPE
        val imageFrame=FrameLayout(this)
        root.addView(imageFrame,FrameLayout.LayoutParams(-1,-1).apply { if(landscape)rightMargin=dp(150) })
        val preview=PreviewView(this).apply { scaleType=PreviewView.ScaleType.FIT_CENTER; implementationMode=PreviewView.ImplementationMode.PERFORMANCE }
        imageFrame.addView(preview,FrameLayout.LayoutParams(-1,-1))
        markView=WatermarkView(this).apply { place=this@MainActivity.place?.optString("placeName") ?: ""; actor=api.identity?.name ?: "" }; imageFrame.addView(markView,FrameLayout.LayoutParams(-1,-1))
        val top=ui.column(16).apply { setBackgroundColor(0x66152c23) }
        val heading=ui.row(); heading.addView(ui.label(place?.optString("placeName") ?: "",17f,Color.WHITE).apply { setTypeface(null,android.graphics.Typeface.BOLD) },LinearLayout.LayoutParams(0,-2,1f))
        heading.addView(ui.button("关闭") { finishCamera() }); ui.full(top,heading)
        message=ui.label("",13f,Color.WHITE).apply { visibility=View.GONE }; ui.full(top,message)
        root.addView(top,FrameLayout.LayoutParams(-1,-2,Gravity.TOP).apply { if(landscape)rightMargin=dp(150) })
        val bottom=ui.column(16).apply { gravity=Gravity.CENTER; setBackgroundColor(0x66152c23) }
        countView=ui.label("已拍 ${counts[0]}  ·  已存 ${counts[1]}  ·  失败 ${counts[2]}",14f,Color.WHITE); bottom.addView(countView); ui.gap(bottom,16)
        val controls=ui.row().apply { gravity=Gravity.CENTER; if(landscape)orientation=LinearLayout.VERTICAL }
        controls.addView(ui.button("重试") { retrySaves() },if(landscape)LinearLayout.LayoutParams(-1,dp(48)) else LinearLayout.LayoutParams(0,dp(48),1f))
        shutter=ui.button("",true) { capture() }.apply { contentDescription="拍照"; isEnabled=false; background=ui.shape(Color.WHITE,48,Color.rgb(150,175,157)); setPadding(dp(5),dp(5),dp(5),dp(5)) }
        controls.addView(shutter,LinearLayout.LayoutParams(dp(78),dp(78)).apply { if(landscape)setMargins(0,dp(10),0,dp(10)) else setMargins(dp(20),0,dp(20),0) })
        controls.addView(ui.button("完成") { finishCamera() },if(landscape)LinearLayout.LayoutParams(-1,dp(48)) else LinearLayout.LayoutParams(0,dp(48),1f)); ui.full(bottom,controls)
        root.addView(bottom,if(landscape)FrameLayout.LayoutParams(dp(150),-1,Gravity.END) else FrameLayout.LayoutParams(-1,-2,Gravity.BOTTOM)); setContentView(root); safe(root,true)
        preview.previewStreamState.observe(this) { state -> if(state==PreviewView.StreamState.STREAMING) { cameraReady=true; updateShutter(); if(cameraOpened!=0L) { Performance.record(this,"cameraFirstFrame",(System.nanoTime()-cameraOpened)/1000000); Performance.record(this,"appToCamera",(System.nanoTime()-started)/1000000); cameraOpened=0 } } }
        if(!bind && previewUseCase!=null && camera!=null) { previewUseCase!!.setSurfaceProvider(preview.surfaceProvider); updateFrame(); return }
        cameraReady=false; cameraOpened=System.nanoTime(); val future=ProcessCameraProvider.getInstance(this); val version=pageVersion
        future.addListener({
            try {
                if(screen!="camera" || version!=pageVersion)return@addListener
                provider=future.get()
                previewUseCase=Preview.Builder().build().also { it.setSurfaceProvider(preview.surfaceProvider) }
                val info=CameraSelector.DEFAULT_BACK_CAMERA.filter(provider!!.availableCameraInfos).first()
                val mode=if(BuildConfig.ENABLE_ZSL && info.isZslSupported)ImageCapture.CAPTURE_MODE_ZERO_SHUTTER_LAG else ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY
                fun build(captureMode: Int)=ImageCapture.Builder().setCaptureMode(captureMode).setJpegQuality(98).setResolutionSelector(ResolutionSelector.Builder().setAllowedResolutionMode(ResolutionSelector.PREFER_HIGHER_RESOLUTION_OVER_CAPTURE_RATE).setResolutionStrategy(ResolutionStrategy.HIGHEST_AVAILABLE_STRATEGY).setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY).build()).build()
                provider!!.unbindAll(); camera=build(mode)
                try { provider!!.bindToLifecycle(this,CameraSelector.DEFAULT_BACK_CAMERA,previewUseCase,camera) }
                catch(e: Exception) { if(mode!=ImageCapture.CAPTURE_MODE_ZERO_SHUTTER_LAG)throw e; provider!!.unbindAll(); camera=build(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY); provider!!.bindToLifecycle(this,CameraSelector.DEFAULT_BACK_CAMERA,previewUseCase,camera) }
                Performance.record(this,"cameraBind",(System.nanoTime()-cameraOpened)/1000000,extra="mode=${camera!!.captureMode}")
                updateFrame(); updateShutter()
            } catch(e: Exception) { tell("相机未能开启，请检查相机权限后重试") }
        },ContextCompat.getMainExecutor(this))
    }
    private fun finishCamera() { if(gate.pending()>0)tell("正在可靠保存捕获文件，请稍候再完成") else { frameStats?.finish(); placesPage(false) } }
    private fun updateShutter() { shutter?.let { it.isEnabled=!captureStorageFault && cameraReady && camera!=null && api.identity!=null && gate.pending()<3 && counts[3]<12 && place?.let { p->placeFresh(p) }==true; it.alpha=if(it.isEnabled)1f else 0.45f } }
    private fun retrySaves() {
        launchIO({ store.checkWritable(); store.schedule(true) }) { captureStorageFault=false; tell("已请求后台重试，原文件保留"); updateShutter() }
    }
    private fun updateFrame() {
        @Suppress("DEPRECATION") val rotation=windowManager.defaultDisplay.rotation
        if(camera?.targetRotation!=rotation)camera?.targetRotation=rotation
        val info=camera?.resolutionInfo ?: return
        markView?.let { val rotated=info.rotationDegrees%180!=0; val w=if(rotated)info.resolution.height else info.resolution.width; val h=if(rotated)info.resolution.width else info.resolution.height
            if(w!=it.photoWidth || h!=it.photoHeight) { it.photoWidth=w; it.photoHeight=h; it.invalidate() } }
    }
    private fun capture() {
        if(!cameraReady) { tell("相机正在准备，请稍候"); return }
        if(captureStorageFault) { tell("本机暂存异常已暂停拍摄，请释放空间后点击重试"); return }
        val output=camera ?: return; val actor=api.identity ?: return; val receipt=place ?: return
        if(!placeFresh(receipt)) { tell("地点已过期，正在更新"); if(!renewing)renew(); return }
        if(counts[3]>=12 || !gate.acquire()) { tell("拍摄队列已满，请等待已拍照片落盘"); return }
        val clicked=System.nanoTime(); val captureSession=session; val snapshot=JSONObject(receipt.toString())
        tell("正在捕获 ${gate.pending()} 张"); updateShutter(); updateFrame()
        captureExecutor.execute {
            var task: Task?=null; var handle: RandomAccessFile?=null; var lock: java.nio.channels.FileLock?=null
            fun completed(error: String?=null, storageFault: Boolean=false) {
                runCatching { lock?.release() }; runCatching { handle?.close() }; gate.release()
                val scheduled=runCatching { store.schedule() }.isSuccess
                runOnUiThread { if(!isDestroyed) { if(storageFault)captureStorageFault=true; tell(error ?: if(!scheduled)"照片已暂存，后台保存未能启动；请在设置重试" else if(gate.pending()>0)"正在捕获 ${gate.pending()} 张" else ""); updateShutter() } else if(gate.pending()==0)captureExecutor.shutdown() }
            }
            try {
                val reservation=store.reserve(actor,snapshot,captureSession); task=reservation.task; val current=reservation.task
                handle=reservation.handle; lock=reservation.lock
                Performance.record(this,"capturePrepare",(System.nanoTime()-clicked)/1000000,current.id)
                runOnUiThread {
                    try {
                        check(active && screen=="camera") { "拍摄界面已离开，未开始新捕获" }
                        output.takePicture(ImageCapture.OutputFileOptions.Builder(current.raw).build(),captureExecutor,object: ImageCapture.OnImageSavedCallback {
                            override fun onCaptureStarted() {
                                // CameraX 1.4 can call this on main even when file callbacks use an executor.
                                // Capture the real callback instant now; persist it off main, before onImageSaved.
                                val at=Instant.now().toString(); val latency=(System.nanoTime()-clicked)/1000000
                                captureExecutor.execute {
                                    current.data.put("capturedAt",at).put("captureStartMs",latency)
                                    runCatching { current.save() }
                                    Performance.record(this@MainActivity,"shutterToCaptureStart",latency,current.id)
                                }
                            }
                            override fun onImageSaved(result: ImageCapture.OutputFileResults) {
                                var failure: String?=null
                                try {
                                    val sync=System.nanoTime(); RandomAccessFile(current.raw,"rw").use { it.fd.sync() }
                                    current.stage=Stage.CAPTURED; current.data.put("captureMs",(System.nanoTime()-clicked)/1000000).put("rawSyncMs",(System.nanoTime()-sync)/1000000); current.save()
                                    Performance.record(this@MainActivity,"captureDurable",(System.nanoTime()-clicked)/1000000,current.id)
                                } catch(e: Exception) { current.stage=Stage.FAILED; current.data.put("error","原文件暂存未完成，已有文件保留"); runCatching { current.save() }; failure="原文件暂存未完成，暂停拍摄并保留文件" }
                                finally { completed(failure,failure!=null) }
                            }
                            override fun onError(e: ImageCaptureException) { current.stage=Stage.FAILED; current.data.put("error","相机捕获失败，任务保留"); runCatching { current.save() }; completed("相机捕获失败，请重试；已有文件保留") }
                        })
                    } catch(e: Exception) { captureExecutor.execute { current.stage=Stage.FAILED; current.data.put("error","捕获未完成"); runCatching { current.save() }; completed("捕获未完成，任务保留") } }
                }
            } catch(e: Exception) { task?.let { it.stage=Stage.FAILED; it.data.put("error","拍摄暂存失败"); runCatching { it.save() } }; completed(friendly(e),e is java.io.IOException || e is SecurityException || e.message?.contains("空间不足")==true) }
        }
    }
    private fun settingsPage() {
        if(gate.pending()>0) { tell("正在捕获，请稍候"); return }
        screen="settings"; base("设置")
        message.maxLines=4
        val body=ui.column(); val scroll=ScrollView(this).apply { addView(body) }
        page.addView(scroll,LinearLayout.LayoutParams(-1,0,1f))
        ui.gap(body,18); ui.full(body,ui.label("春茉工地拍照",22f)); ui.gap(body,8)
        ui.full(body,ui.label("${BuildConfig.VERSION_NAME} · 内部测试签名",13f,ui.muted)); ui.gap(body,22)
        val updater=AppUpdater(this); val updates=ui.column(); var busy=false
        val check=ui.button("检查更新",true) {
            if(busy)return@button
            busy=true; tell("正在检查更新"); updates.removeAllViews(); val version=pageVersion
            lifecycleScope.launch {
                try {
                    val release=withContext(Dispatchers.IO) { updater.check() }
                    if(version!=pageVersion)return@launch
                    if(release.code<=BuildConfig.VERSION_CODE) { tell("当前已是此发布渠道的最新版本"); return@launch }
                    tell("发现新版本 ${release.name}")
                    ui.full(updates,ui.label(release.notes,14f,ui.muted)); ui.gap(updates,12)
                    val download=ui.button("下载更新",true) {}
                    download.setOnClickListener {
                        if(busy)return@setOnClickListener
                        busy=true; download.isEnabled=false
                        lifecycleScope.launch {
                            try {
                                val file=withContext(Dispatchers.IO) { updater.download(release) { n->runOnUiThread { if(version==pageVersion)tell("正在下载 $n%") } } }
                                if(version!=pageVersion)return@launch
                                tell("完整性与签名校验通过，请确认覆盖安装")
                                download.text="安装更新"; download.setOnClickListener {
                                    try { if(!updater.install(file,release))tell("请授权本应用安装更新，然后返回点击安装更新") else tell("已打开系统安装界面，请确认；本机照片和数据保留") }
                                    catch(e: Exception) { tell(friendly(e)) }
                                }
                            } catch(e: Exception) { if(version==pageVersion)tell(friendly(e)) }
                            finally { busy=false; download.isEnabled=true }
                        }
                    }
                    ui.full(updates,download,50)
                } catch(e: Exception) { if(version==pageVersion)tell(friendly(e)) }
                finally { busy=false }
            }
        }
        ui.full(body,check,50); ui.gap(body,12); ui.full(body,updates)
        ui.gap(body,14); recoveryView=ui.label("",13f,ui.muted); ui.full(body,recoveryView!!)
        ui.full(body,ui.button("重试本机未保存照片") { retrySaves() })
        ui.gap(body,10); ui.full(body,ui.button("系统权限") { startActivity(Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,android.net.Uri.parse("package:$packageName"))) })
        if(api.identity!=null) { ui.gap(body,14); ui.full(body,ui.button("退出账号") { launchIO({ api.logout() }) { revoked -> loginPage(); if(!revoked)tell("已退出本机，服务器会话撤销尚未确认") } }) }
    }
}
