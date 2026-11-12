package cn.chmsj.photo

import android.content.Context
import android.os.Debug
import android.util.Log
import org.json.JSONObject
import java.io.File

/** Bounded device-local stage timings, never coordinates, credentials or personnel names. */
object Performance {
    @Synchronized fun record(context: Context, stage: String, ms: Long, task: String="", extra: String="") {
        val row=JSONObject().put("stage",stage).put("ms",ms).put("task",task)
            .put("at",System.currentTimeMillis()).put("heapBytes",Runtime.getRuntime().totalMemory()-Runtime.getRuntime().freeMemory())
            .put("nativeHeapBytes",Debug.getNativeHeapAllocatedSize()).put("detail",extra)
        Log.i("ChunmoPerf",row.toString())
        // File writes happen off the UI thread; UI frame metrics use logcat only.
        if(android.os.Looper.myLooper()==android.os.Looper.getMainLooper()) return
        runCatching {
            val file=File(context.filesDir,"performance.jsonl")
            if(file.length()>2*1024*1024) file.renameTo(File(context.filesDir,"performance.previous.jsonl"))
            file.appendText(row.toString()+"\n")
        }
    }
}

class CaptureGate(private val limit: Int=3) {
    private var used=0
    @Synchronized fun acquire(): Boolean { if(used>=limit)return false; used++; return true }
    @Synchronized fun release() { check(used>0); used-- }
    @Synchronized fun pending()=used
}
