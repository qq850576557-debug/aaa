package cn.chmsj.photo

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL

private object UpdateLock
class AppUpdater(private val context: Context) {
    private val origin=BuildConfig.API_ORIGIN
    private val directory=File(context.filesDir,"updates").apply { mkdirs() }
    private fun connection(url: String): HttpURLConnection {
        trustedDownload(url,origin)
        return (URL(url).openConnection() as HttpURLConnection).apply {
            instanceFollowRedirects=false; connectTimeout=15000; readTimeout=30000
            setRequestProperty("Accept-Encoding","identity")
        }
    }
    fun check(): AppRelease {
        val c=connection("$origin/download/update.json")
        try {
            check(c.responseCode==200) { "暂未取得工作室版本清单，请稍后重试" }
            val bytes=c.inputStream.use { input ->
                val out=java.io.ByteArrayOutputStream(); val buffer=ByteArray(4096)
                while(out.size()<=65536) { val n=input.read(buffer); if(n<0)break; out.write(buffer,0,n) }
                out.toByteArray()
            }
            check(bytes.size<=65536) { "版本清单过大" }
            return AppRelease.parse(JSONObject(String(bytes,Charsets.UTF_8)),origin)
        } finally { c.disconnect() }
    }
    fun download(release: AppRelease, progress: (Int)->Unit): File = synchronized(UpdateLock) {
        check(release.code>BuildConfig.VERSION_CODE) { "禁止降级或重复安装当前版本" }
        val target=File(directory,"${release.code}-${release.sha}.apk")
        if(target.isFile && target.length()==release.bytes && fileHash(target)==release.sha) { verify(target,release); return target }
        check(directory.usableSpace>release.bytes*2+20*1024*1024) { "安装包暂存空间不足" }
        val temp=File(directory,"${release.code}-${release.sha}.part.apk")
        val c=connection(release.url)
        try {
            check(c.responseCode==200 && (c.contentLengthLong==-1L || c.contentLengthLong==release.bytes)) { "安装包下载响应不符" }
            var total=0L; var previous=-1
            c.inputStream.use { input -> FileOutputStream(temp).use { out ->
                val buffer=ByteArray(65536)
                while(true) {
                    if(Thread.currentThread().isInterrupted) error("下载已取消")
                    val n=input.read(buffer); if(n<0)break
                    total+=n; check(total<=release.bytes) { "安装包大小不符" }; out.write(buffer,0,n)
                    val next=(total*100/release.bytes).toInt(); if(next!=previous) { progress(next); previous=next }
                }
                out.flush(); out.fd.sync()
            } }
            check(total==release.bytes && fileHash(temp)==release.sha) { "安装包完整性校验失败，请重试" }
            verify(temp,release)
            check(temp.renameTo(target)) { "安装包暂存失败" }
            return target
        } finally { c.disconnect(); temp.delete() } // Only an incomplete updater file; never photo files.
    }
    @Suppress("DEPRECATION")
    fun verify(file: File, release: AppRelease) {
        check(file.length()==release.bytes && fileHash(file)==release.sha) { "安装包校验失败" }
        val pm=context.packageManager
        val candidate=pm.getPackageArchiveInfo(file.path,PackageManager.GET_SIGNING_CERTIFICATES) ?: error("安装包不可读取")
        val installed=pm.getPackageInfo(context.packageName,PackageManager.GET_SIGNING_CERTIFICATES)
        fun certs(info: android.content.pm.PackageInfo)=info.signingInfo?.apkContentsSigners?.map { digest(it.toByteArray()) }?.toSet() ?: emptySet()
        val current=certs(installed)
        check(current.isNotEmpty() && current==certs(candidate)) { "更新签名与已安装版本不一致，已拒绝安装" }
        check(candidate.packageName==context.packageName && candidate.longVersionCode==release.code && candidate.longVersionCode>installed.longVersionCode && candidate.versionName==release.name) { "安装包身份或版本不符" }
        check((candidate.applicationInfo?.minSdkVersion ?: Int.MAX_VALUE)<=android.os.Build.VERSION.SDK_INT) { "此更新不支持当前系统版本" }
    }
    fun install(file: File, release: AppRelease): Boolean {
        verify(file,release) // Recheck immediately before granting installer read access.
        if(!context.packageManager.canRequestPackageInstalls()) {
            context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:${context.packageName}")))
            return false
        }
        val uri=FileProvider.getUriForFile(context,"${context.packageName}.updates",file)
        context.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri,"application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
        return true // Installation UI opened; not an installation success receipt.
    }
}
