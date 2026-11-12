package cn.chmsj.photo

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class UpgradeUnitTest {
    private fun release()=JSONObject().put("package","cn.chmsj.photo").put("versionCode",3).put("versionName","test")
        .put("bytes",11000).put("sha256","a".repeat(64)).put("apkUrl","https://chmsj.cn/download/releases/3/photo.apk").put("notes","修复")
    @Test fun onlyExactBuildOriginAndSafeDownloadPathAreTrusted() {
        AppRelease.parse(release(),"https://chmsj.cn")
        for(url in listOf("http://chmsj.cn/download/a.apk","https://chmsj.cn.evil.test/download/a.apk","https://evil.test/download/a.apk","https://chmsj.cn:443/download/a.apk","https://user@chmsj.cn/download/a.apk","https://chmsj.cn/download/../api/login","https://chmsj.cn/download/%2e%2e/a.apk","https://chmsj.cn/download/a.apk?url=evil","https://chmsj.cn/download/a.apk#x")) {
            assertThrows(IllegalArgumentException::class.java) { AppRelease.parse(release().put("apkUrl",url),"https://chmsj.cn") }
        }
    }
    @Test fun invalidPackageHashSizeAndVersionFailClosed() {
        for(field in listOf("package","sha256","bytes","versionCode")) {
            val value=release().put(field,when(field) { "package"->"another.app"; "sha256"->"bad"; "bytes"->200L*1024*1024; else->0 })
            assertThrows(IllegalArgumentException::class.java) { AppRelease.parse(value,"https://chmsj.cn") }
        }
    }
    @Test fun captureGateBoundsAndReleasesWithoutDroppingAcceptedWork() {
        val gate=CaptureGate(3)
        repeat(3) { assertTrue(gate.acquire()) }; assertFalse(gate.acquire()); assertEquals(3,gate.pending())
        gate.release(); assertTrue(gate.acquire()); repeat(3) { gate.release() }; assertEquals(0,gate.pending())
        assertThrows(IllegalStateException::class.java) { gate.release() }
    }
    @Test fun concurrentCaptureRequestsNeverExceedCapacity() {
        val gate=CaptureGate(3); val accepted=java.util.concurrent.atomic.AtomicInteger()
        val threads=(1..30).map { kotlin.concurrent.thread { if(gate.acquire())accepted.incrementAndGet() } }
        threads.forEach { it.join() }; assertEquals(3,accepted.get()); assertEquals(3,gate.pending())
    }
}
