package cn.chmsj.photo

import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.math.min

data class Identity(val id: String, val workspace: String, val name: String) {
    fun json() = JSONObject().put("id", id).put("workspace", workspace).put("name", name)
    val scope: String get() = digest("$workspace:$id".toByteArray()).take(32)
    companion object { fun parse(o: JSONObject) = Identity(o.getString("id"), o.getString("workspace"), o.getString("name")) }
}
fun digest(bytes: ByteArray) = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
fun locationFresh(o: JSONObject, now: Long = System.currentTimeMillis()): Boolean = try {
    val age = now - Instant.parse(o.getString("obtainedAt")).toEpochMilli()
    o.getDouble("latitude") in -90.0..90.0 && o.getDouble("longitude") in -180.0..180.0 &&
        o.getDouble("accuracy") in 0.0..100.0 && age in -5000L..90000L
} catch (_: Exception) { false }
fun placeFresh(o: JSONObject, now: Long = System.currentTimeMillis()): Boolean = try {
    o.getString("placeSource") == "amap-poi-selected" && o.getString("token").isNotBlank() &&
        o.getJSONObject("poi").getString("id").isNotBlank() && o.getString("placeName").isNotBlank() &&
        locationFresh(o.getJSONObject("location"), now) && Instant.parse(o.getString("expiresAt")).toEpochMilli() >= now
} catch (_: Exception) { false }
val photoClock: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy.MM.dd HH:mm").withZone(ZoneId.of("Asia/Shanghai"))
data class Mark(val x: Float, val y: Float, val width: Float, val height: Float, val scale: Float, val lines: List<String>)
fun markLayout(w: Int, h: Int, place: String, at: String, actor: String): Mark {
    require(w > 0 && h > 0)
    val s = min(w / 1100f, h / 800f)
    val lines = listOf("工地定位：$place", "拍摄时间：${photoClock.format(Instant.parse(at))}", "拍摄人员：$actor")
        .flatMap { it.chunked(26) }
    val height = (44 + 50 + 24 + 35 * (lines.size - 1)) * s
    return Mark(16*s, h-height-16*s, min(w-32*s, 780*s), height, s, lines)
}
