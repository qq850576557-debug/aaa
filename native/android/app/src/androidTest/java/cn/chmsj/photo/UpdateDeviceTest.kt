package cn.chmsj.photo

import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Test
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.runner.RunWith
import java.io.File

/** Actual Android package/certificate parsing against app-private, emulator-only APK fixtures. */
@RunWith(AndroidJUnit4::class)
class UpdateDeviceTest {
    @Test fun platformChecksAcceptSameSignerAndRejectChangedSignerHashAndDowngrade() {
        assumeTrue(Build.HARDWARE in listOf("ranchu","goldfish"))
        val ctx=InstrumentationRegistry.getInstrumentation().targetContext
        val valid=File(ctx.filesDir,"update-valid.apk"); val wrongSigner=File(ctx.filesDir,"update-wrong-signer.apk")
        assumeTrue("Prepare controlled SDK-signed fixtures first",valid.exists() && wrongSigner.exists())
        val updater=AppUpdater(ctx)
        fun release(f: File)=AppRelease(3,"2.0.1-internal",f.length(),fileHash(f),"https://chmsj.cn/download/test.apk","test only")
        updater.verify(valid,release(valid))
        val signature=assertThrows(IllegalStateException::class.java) { updater.verify(wrongSigner,release(wrongSigner)) }
        assertTrue(signature.message!!.contains("签名"))
        assertThrows(IllegalStateException::class.java) { updater.verify(valid,release(valid).copy(sha="0".repeat(64))) }
        assertThrows(IllegalStateException::class.java) { updater.verify(valid,release(valid).copy(code=1)) }
        val paths=ctx.resources.getXml(R.xml.update_paths)
        var text=""; while(paths.next()!=org.xmlpull.v1.XmlPullParser.END_DOCUMENT)text+=paths.getAttributeValue(null,"path") ?: ""
        assertEquals("updates/",text) // Installer provider cannot expose photo tasks or session files.
    }
}
