package cn.chmsj.photo

import org.json.JSONObject
import java.net.URI

data class AppRelease(val code: Long, val name: String, val bytes: Long, val sha: String, val url: String, val notes: String) {
    companion object {
        fun parse(o: JSONObject, origin: String): AppRelease {
            val code=o.getLong("versionCode"); val bytes=o.getLong("bytes"); val sha=o.getString("sha256")
            require(code>0 && bytes in 1..(100L*1024*1024) && Regex("[a-f0-9]{64}").matches(sha)) { "版本清单校验失败" }
            require(o.getString("package")=="cn.chmsj.photo") { "更新包名不符" }
            val url=o.getString("apkUrl"); trustedDownload(url,origin)
            return AppRelease(code,o.getString("versionName").take(64),bytes,sha,url,o.getString("notes").take(3000))
        }
    }
}
fun trustedDownload(value: String, origin: String) {
    val u=URI(value); val root=URI(origin)
    require(u.scheme=="https" && u.host==root.host && u.port==root.port && u.rawUserInfo==null && u.rawQuery==null && u.rawFragment==null &&
        u.rawPath.startsWith("/download/") && u.rawPath==u.path && u.normalize()==u && !u.path.contains("\\")) { "拒绝非工作室下载地址" }
}
