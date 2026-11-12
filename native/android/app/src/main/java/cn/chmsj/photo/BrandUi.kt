package cn.chmsj.photo

import android.content.Context
import android.graphics.*
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.graphics.drawable.StateListDrawable
import android.content.res.ColorStateList
import android.view.Gravity
import android.view.View
import android.widget.*

/** Shared desktop brand tokens; native controls retain accessibility and focus behavior. */
class BrandUi(val context: Context) {
    val green = Color.rgb(36,78,66)
    val ink = Color.rgb(41,61,52)
    val muted = Color.rgb(97,114,105)
    val background = Color.rgb(247,248,244)
    val edge = Color.rgb(227,232,224)
    fun dp(n: Int) = (n*context.resources.displayMetrics.density).toInt()
    fun shape(color: Int, radius: Int=14, stroke: Int?=null) = GradientDrawable().apply {
        setColor(color); cornerRadius=dp(radius).toFloat()
        if(stroke!=null) setStroke(dp(1),stroke)
    }
    fun label(value: String, size: Float=15f, color: Int=ink) = TextView(context).apply {
        text=value; textSize=size; setTextColor(color); includeFontPadding=false
    }
    fun column(padding: Int=0) = LinearLayout(context).apply {
        orientation=LinearLayout.VERTICAL; setPadding(dp(padding),dp(padding),dp(padding),dp(padding))
    }
    fun row() = LinearLayout(context).apply { gravity=Gravity.CENTER_VERTICAL }
    fun button(value: String, primary: Boolean=false, action: ()->Unit) = Button(context).apply {
        text=value; textSize=15f; isAllCaps=false; minHeight=dp(48); minimumHeight=dp(48)
        setPadding(dp(16),dp(10),dp(16),dp(10)); stateListAnimator=null
        setTextColor(ColorStateList(arrayOf(intArrayOf(-android.R.attr.state_enabled),intArrayOf()),intArrayOf(muted,if(primary) Color.WHITE else green)))
        background=StateListDrawable().apply {
            addState(intArrayOf(-android.R.attr.state_enabled),shape(edge,12))
            addState(intArrayOf(),RippleDrawable(ColorStateList.valueOf(0x22244e42),shape(if(primary)green else Color.WHITE,12,if(primary)null else edge),null))
        }
        setOnClickListener { action() }
    }
    fun field(hintText: String) = EditText(context).apply {
        hint=hintText; textSize=16f; isSingleLine=true; setTextColor(ink); setHintTextColor(muted)
        setPadding(dp(14),dp(10),dp(14),dp(10)); minHeight=dp(50)
        background=shape(Color.WHITE,12,edge)
    }
    fun gap(parent: LinearLayout, n: Int=12) { parent.addView(View(context),LinearLayout.LayoutParams(1,dp(n))) }
    fun full(parent: LinearLayout, child: View, height: Int=-2) { parent.addView(child,LinearLayout.LayoutParams(-1,if(height<0)height else dp(height))) }
}

class CameraGlyph(context: Context) : View(context) {
    private val p=Paint(Paint.ANTI_ALIAS_FLAG).apply { color=Color.WHITE; style=Paint.Style.STROKE; strokeWidth=2.4f }
    override fun onDraw(canvas: Canvas) {
        canvas.save(); canvas.scale(width/40f,height/40f)
        canvas.drawRoundRect(5f,12f,35f,32f,4f,4f,p)
        canvas.drawCircle(20f,22f,6f,p)
        canvas.drawLine(12f,12f,15f,7f,p); canvas.drawLine(15f,7f,25f,7f,p); canvas.drawLine(25f,7f,28f,12f,p)
        canvas.restore()
    }
}
