package cn.chmsj.photo

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Looper
import androidx.core.content.ContextCompat
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import java.time.Instant
import kotlin.coroutines.resume

/** Foreground real WGS84 readings only. Server performs the provider coordinate transform. */
class Gps(private val context: Context) {
    suspend fun locate(): JSONObject = withTimeout(20000) {
        check(ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) { "请允许精确定位" }
        val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        check(manager.isProviderEnabled(LocationManager.GPS_PROVIDER)) { "请开启手机GPS定位" }
        suspendCancellableCoroutine { continuation ->
            val listener = object : LocationListener {
                override fun onLocationChanged(location: Location) {
                    val value = JSONObject().put("latitude",location.latitude).put("longitude",location.longitude)
                        .put("accuracy",location.accuracy.toDouble()).put("obtainedAt",Instant.ofEpochMilli(location.time).toString())
                    if (location.hasAccuracy() && locationFresh(value) && continuation.isActive) {
                        manager.removeUpdates(this); continuation.resume(value)
                    }
                }
                override fun onProviderDisabled(provider: String) { }
                override fun onProviderEnabled(provider: String) { }
                @Deprecated("Legacy Android 10 callback")
                override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) { }
            }
            manager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 500L, 0f, listener, Looper.getMainLooper())
            continuation.invokeOnCancellation { manager.removeUpdates(listener) }
        }
    }
}
