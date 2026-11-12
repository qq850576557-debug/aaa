package cn.chmsj.photo
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Test
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.runner.RunWith
import java.io.*
import java.net.HttpURLConnection
import java.time.Instant

/** Synthetic identities and GPS; actual native views, camera files and emulator MediaStore. */
@androidx.test.filters.SdkSuppress(minSdkVersion=35)
@RunWith(AndroidJUnit4::class)
class NativeUiTest {
    private val inst get()=InstrumentationRegistry.getInstrumentation()
    private fun context(): android.content.Context { assumeTrue(Build.HARDWARE in listOf("ranchu","goldfish")); return inst.targetContext }
    private fun point()=JSONObject().put("latitude",30).put("longitude",120).put("accuracy",12).put("obtainedAt",Instant.now().toString())
    private fun receipt(id: String="lab-a")=JSONObject().put("placeSource","amap-poi-selected").put("placeName","模拟现场 · 原生界面测试").put("token","emulator-only").put("poi",JSONObject().put("id",id)).put("expiresAt",Instant.now().plusSeconds(90).toString()).put("location",point())
    private fun field(a: MainActivity,name: String,value: Any?) { a.javaClass.getDeclaredField(name).apply { isAccessible=true }.set(a,value) }
    private fun invoke(a: MainActivity,name: String,flag: Boolean?=null) {
        val m=if(flag==null)a.javaClass.getDeclaredMethod(name) else a.javaClass.getDeclaredMethod(name,Boolean::class.javaPrimitiveType)
        m.isAccessible=true; if(flag==null)m.invoke(a) else m.invoke(a,flag)
    }
    private fun shell(command: String) {
        inst.uiAutomation.executeShellCommand(command).use { fd -> java.io.FileInputStream(fd.fileDescriptor).use { it.readBytes() } }
    }
    private fun screenshot(name: String,window: android.view.Window) {
        // Wait for the NEW native window frame, not just the view-tree mutation.
        // Slow software emulation can otherwise return the previous page's surface.
        val committed=java.util.concurrent.CountDownLatch(1)
        inst.runOnMainSync { window.decorView.viewTreeObserver.registerFrameCommitCallback { committed.countDown() }; window.decorView.postInvalidateOnAnimation() }
        assertTrue("New native frame committed",committed.await(30,java.util.concurrent.TimeUnit.SECONDS))
        Thread.sleep(150); val image=inst.uiAutomation.takeScreenshot(window) ?: error("No screenshot")
        val f=File(context().cacheDir,"v2-screens/$name.png"); f.parentFile!!.mkdirs()
        FileOutputStream(f).use { assertTrue(image.compress(Bitmap.CompressFormat.PNG,100,it)) }; image.recycle()
    }
    @Test fun cameraPerformanceAndThreeRealScreens() {
        val ctx=context(); val session="ui-camera-${System.currentTimeMillis()}"; val store=QueueStore(ctx)
        val a=inst.startActivitySync(Intent(ctx,MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
        try {
            println("UI_PHASE=login"); Thread.sleep(1200); screenshot("login",a.window); println("UI_PHASE=login-done")
            val vault=object: SessionStorage { override fun read(): JSONObject?=null; override fun save(data: JSONObject){}; override fun clear(){} }
            val api=Api(vault) { url -> object: HttpURLConnection(url) {
                override fun connect(){}; override fun disconnect(){}; override fun usingProxy()=false
                override fun getResponseCode()=200
                override fun getHeaderFields(): MutableMap<String,MutableList<String>> = mutableMapOf("Set-Cookie" to mutableListOf("chunmo_session=synthetic"))
                override fun getOutputStream()=ByteArrayOutputStream()
                override fun getInputStream()=ByteArrayInputStream(when(url.path) {
                    "/api/auth/session"->"{\"csrf\":\"synthetic\",\"user\":{\"id\":\"emulator-ui\",\"workspaceId\":\"isolated\"}}"
                    "/api/site-photos/config"->"{\"actorId\":\"emulator-ui\",\"actorName\":\"模拟器测试监理\"}"
                    else->"{}"
                }.toByteArray())
            } }
            api.login("synthetic","not-real")
            inst.runOnMainSync {
                field(a,"api",api); field(a,"location",point()); field(a,"selected",receipt())
                runCatching {
                    @Suppress("UNCHECKED_CAST") val choices=a.javaClass.getDeclaredField("choices").apply { isAccessible=true }.get(a) as MutableList<JSONObject>
                    repeat(10) { choices.add(JSONObject().put("id","lab-$it").put("name","模拟现场 ${it+1}").put("distance",30+it*45).put("address","仅模拟器测试资料").put("receipt",receipt("lab-$it"))) }
                    invoke(a,"placesPage",false); field(a,"selected",choices[0].getJSONObject("receipt")); invoke(a,"renderPlaces")
                }
            }
            println("UI_PHASE=places"); Thread.sleep(500); screenshot("places",a.window); println("UI_PHASE=places-done")
            if(InstrumentationRegistry.getArguments().getString("layouts")=="true") {
                for(width in listOf(320,360,390,430)) {
                    val pixels=(width*ctx.resources.displayMetrics.density).toInt()
                    shell("wm size ${pixels}x1170"); Thread.sleep(1000)
                    inst.runOnMainSync { invoke(a,"loginPage") }; Thread.sleep(400); screenshot("login-$width",a.window)
                    inst.runOnMainSync { invoke(a,"placesPage",false) }; Thread.sleep(400); screenshot("places-$width",a.window)
                    inst.runOnMainSync {
                        fun find(view: android.view.View): android.widget.Button? {
                            if(view is android.widget.Button && view.text.toString()=="确认地点并拍摄")return view
                            if(view is android.view.ViewGroup)for(i in 0 until view.childCount) { val result=find(view.getChildAt(i)); if(result!=null)return result }
                            return null
                        }
                        val button=find(a.window.decorView)!!; val bounds=android.graphics.Rect()
                        assertTrue("Fixed confirmation visible at ${width}dp",button.getGlobalVisibleRect(bounds))
                        assertTrue(bounds.height()>=44*ctx.resources.displayMetrics.density)
                    }
                }
                shell("wm size 540x1170"); Thread.sleep(800)
            }
            val opened=System.nanoTime(); inst.runOnMainSync { field(a,"place",receipt()); field(a,"session",session); invoke(a,"cameraPage",true) }
            val ready=System.currentTimeMillis()+90000
            while(System.currentTimeMillis()<ready) { var bound=false; inst.runOnMainSync { bound=a.javaClass.getDeclaredField("camera").apply { isAccessible=true }.get(a)!=null }; if(bound)break; Thread.sleep(200) }
            println("UI_PHASE=camera"); val frameDeadline=System.currentTimeMillis()+90000
            while(System.currentTimeMillis()<frameDeadline) { var streaming=false; inst.runOnMainSync { streaming=a.javaClass.getDeclaredField("cameraReady").apply { isAccessible=true }.getBoolean(a) }; if(streaming)break; Thread.sleep(300) }
            Thread.sleep(500); screenshot("camera",a.window); println("UI_PHASE=camera-done"); val bindMs=(System.nanoTime()-opened)/1000000
            val limit=InstrumentationRegistry.getArguments().getString("photoCount","20")!!.toInt().coerceIn(0,20)
            if(limit==0) {
                shell("settings put system accelerometer_rotation 0"); shell("settings put system user_rotation 1"); Thread.sleep(1200)
                screenshot("camera-landscape",a.window)
                shell("settings put system user_rotation 0"); Thread.sleep(500)
                return
            }
            val start=System.currentTimeMillis(); val deadline=start+600000
            // Poll indexed counters, not all historical JSON, so instrumentation does not create the bottleneck.
            while(System.currentTimeMillis()<deadline && store.statistics(session)[4]<limit) {
                inst.runOnMainSync { field(a,"place",receipt()); invoke(a,"capture") }; Thread.sleep(400)
            }
            assertEquals("All requested captures accepted",limit,store.statistics(session)[4])
            while(System.currentTimeMillis()<deadline && store.statistics(session)[1]+store.statistics(session)[2]<limit)Thread.sleep(400)
            val tasks=store.all().filter { it.data.optString("session")==session }; assertEquals("All real camera files saved",limit,tasks.count { it.stage==Stage.SAVED })
            val report=JSONObject().put("emulatorOnly",true).put("requested",limit).put("versionName",ctx.packageManager.getPackageInfo(ctx.packageName,0).versionName).put("bindAndWaitMs",bindMs).put("wallMs",System.currentTimeMillis()-start)
                .put("tasks",org.json.JSONArray(tasks.map { t -> JSONObject(t.data.toString()).apply { remove("receipt"); remove("actor"); remove("mediaUri") } }))
            File(ctx.cacheDir,"camera-performance.json").writeText(report.toString(2)); println("EMULATOR_CAMERA_RESULT="+report.toString())
        } finally { inst.runOnMainSync { a.finish() } }
    }
    @Test fun seedUpgradeProofOnlyOnEmulator() {
        val ctx=context(); val proof=File(ctx.filesDir,"upgrade-proof.json"); assumeTrue(!proof.exists() && SessionVault(ctx).read()==null)
        val task=QueueStore(ctx).create(Identity("upgrade-fixture","isolated","测试监理"),receipt(),"upgrade-v1")
        val image=Bitmap.createBitmap(800,600,Bitmap.Config.ARGB_8888).apply { eraseColor(Color.LTGRAY) }
        FileOutputStream(task.raw).use { image.compress(Bitmap.CompressFormat.JPEG,98,it); it.fd.sync() }; image.recycle(); task.stage=Stage.CAPTURED; task.save()
        val cookie=JSONObject().put("origin","https://chmsj.cn").put("cookie","synthetic-upgrade-only"); SessionVault(ctx).save(cookie)
        proof.writeText(JSONObject().put("id",task.id).put("rawHash",fileHash(task.raw)).put("cookie",cookie).toString())
    }
    @Test fun verifyUpgradeProofAndKeystoreWithoutNetwork() {
        val ctx=context(); val f=File(ctx.filesDir,"upgrade-proof.json"); assumeTrue(f.exists()); val proof=JSONObject(f.readText())
        assertEquals(proof.getJSONObject("cookie").toString(),SessionVault(ctx).read()!!.toString())
        val task=QueueStore(ctx).all().first { it.id==proof.getString("id") }; assertEquals(Stage.CAPTURED,task.stage); assertEquals(proof.getString("rawHash"),fileHash(task.raw))
        SessionVault(ctx).clear(); f.renameTo(File(ctx.filesDir,"upgrade-proof-verified.json")) // Own synthetic emulator fixture only.
    }
}
