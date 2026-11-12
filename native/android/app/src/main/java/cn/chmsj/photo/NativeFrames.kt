package cn.chmsj.photo

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.view.FrameMetrics
import android.view.Window

/** Real window frame timings, sampled off the UI thread and bounded per camera session. */
class NativeFrames(private val context: Context, private val window: Window) {
    private val thread=HandlerThread("chunmo-frame-metrics").apply { start() }
    private val handler=Handler(thread.looper)
    @Volatile private var enabled=false
    private var frames=0L
    private var slow=0L
    private var maxNs=0L
    private val listener=Window.OnFrameMetricsAvailableListener { _,metrics,dropped ->
        if(enabled) {
            val ns=metrics.getMetric(FrameMetrics.TOTAL_DURATION)
            frames++; if(ns>32000000)slow++; maxNs=maxOf(maxNs,ns)
        }
    }
    init { window.addOnFrameMetricsAvailableListener(listener,handler) }
    fun start() { handler.post { frames=0; slow=0; maxNs=0; enabled=true } }
    fun finish() { handler.post { if(enabled) { enabled=false; Performance.record(context,"cameraUiFramesMax",maxNs/1000000,extra="frames=$frames;over32ms=$slow") } } }
    fun close() { window.removeOnFrameMetricsAvailableListener(listener); finish(); thread.quitSafely() }
}
