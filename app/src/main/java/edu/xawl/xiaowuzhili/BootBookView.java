package edu.xawl.xiaowuzhili;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RadialGradient;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.os.SystemClock;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.animation.LinearInterpolator;

/**
 * 校务智理 v1.035 · 原生 60fps「微风翻书 · 校园灵感漫游」启动动画视图
 */
public class BootBookView extends View {

    private static final float FLIP_CYCLE_SEC = 1.80f;
    private static final float FLOAT_CYCLE_SEC = 2.40f;
    private static final float BUBBLE_CYCLE_SEC = 3.25f;
    private static final int SPARK_COUNT = 8;

    private final float density;
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint strokePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint textPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF rect = new RectF();
    private final Path path = new Path();

    private ValueAnimator animator;
    private long lastFrameMs = 0L;
    private float animTimeSec = 0f;
    private boolean isPaused = false;
    private boolean isDark = false;

    private long boingStartMs = 0L;
    private final float[] sparkDx = new float[SPARK_COUNT];
    private final float[] sparkDy = new float[SPARK_COUNT];
    private final int[] sparkColor = new int[SPARK_COUNT];
    private static final int[] SPARK_PALETTE = new int[]{
            Color.parseColor("#38BDF8"),
            Color.parseColor("#3B82F6"),
            Color.parseColor("#6366F1"),
            Color.parseColor("#10B981"),
            Color.parseColor("#F59E0B"),
            Color.parseColor("#A855F7"),
            Color.parseColor("#06B6D4"),
            Color.parseColor("#EC4899")
    };

    private long readyStartMs = 0L;

    public BootBookView(Context context) {
        super(context);
        this.density = context.getResources().getDisplayMetrics().density;
        strokePaint.setStyle(Paint.Style.STROKE);
        strokePaint.setStrokeCap(Paint.Cap.ROUND);
        strokePaint.setStrokeJoin(Paint.Join.ROUND);

        textPaint.setTextAlign(Paint.Align.CENTER);
        textPaint.setTypeface(Typeface.DEFAULT_BOLD);
        setClickable(true);
        setFocusable(true);
    }

    public void setDarkMode(boolean dark) {
        if (this.isDark != dark) {
            this.isDark = dark;
            invalidate();
        }
    }

    public void setPaused(boolean paused) {
        if (this.isPaused == paused) return;
        this.isPaused = paused;
        if (!paused) {
            lastFrameMs = SystemClock.uptimeMillis();
        }
        invalidate();
    }

    public void startAnimation() {
        readyStartMs = 0L;
        isPaused = false;
        lastFrameMs = 0L;
        if (animator != null && animator.isRunning()) return;
        animator = ValueAnimator.ofFloat(0f, 1f);
        animator.setDuration(1000L);
        animator.setRepeatCount(ValueAnimator.INFINITE);
        animator.setInterpolator(new LinearInterpolator());
        animator.addUpdateListener(a -> invalidate());
        animator.start();
    }

    public void stopAnimation() {
        if (animator != null) {
            animator.cancel();
            animator = null;
        }
        lastFrameMs = 0L;
    }

    public void triggerBoing() {
        boingStartMs = SystemClock.uptimeMillis();
        for (int i = 0; i < SPARK_COUNT; i++) {
            double ang = (Math.PI * 2.0 * i) / SPARK_COUNT + ((i % 2 == 0) ? 0.14 : -0.14);
            float dist = dp(44f + (i % 3) * 13f);
            sparkDx[i] = (float) (Math.cos(ang) * dist);
            sparkDy[i] = (float) (Math.sin(ang) * dist - dp(14f));
            sparkColor[i] = SPARK_PALETTE[i % SPARK_PALETTE.length];
        }
        try {
            performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP);
        } catch (Exception ignored) {
        }
        invalidate();
    }

    public void triggerReady() {
        readyStartMs = SystemClock.uptimeMillis();
        invalidate();
    }

    @Override
    protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        if (getVisibility() == VISIBLE) startAnimation();
    }

    @Override
    protected void onDetachedFromWindow() {
        stopAnimation();
        super.onDetachedFromWindow();
    }

    @Override
    protected void onVisibilityChanged(View changedView, int visibility) {
        super.onVisibilityChanged(changedView, visibility);
        if (visibility == VISIBLE) startAnimation();
        else stopAnimation();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        int w = getWidth();
        int h = getHeight();
        if (w <= 0 || h <= 0) return;

        long now = SystemClock.uptimeMillis();
        if (!isPaused) {
            if (lastFrameMs > 0L) {
                long deltaMs = Math.min(40L, Math.max(0L, now - lastFrameMs));
                animTimeSec += deltaMs / 1000f;
            }
            lastFrameMs = now;
        }
        float tSec = animTimeSec;

        float cx = w * 0.5f;
        float baseBookCy = h - dp(54f);
        float floatPhase = (float) Math.sin((tSec / FLOAT_CYCLE_SEC) * Math.PI * 2.0);
        float floatY = -dp(6f) * (0.5f + 0.5f * floatPhase);

        float scaleX = 1f;
        float scaleY = 1f;
        float boingY = 0f;
        if (boingStartMs > 0L) {
            float bt = (now - boingStartMs) / 480f;
            if (bt >= 0f && bt < 1f) {
                float damp = (float) Math.exp(-bt * 4.5);
                float osc = (float) Math.sin(bt * Math.PI * 2.5);
                scaleX = 1f + 0.14f * damp * osc;
                scaleY = 1f - 0.12f * damp * osc;
                boingY = -dp(10f) * (float) Math.sin(bt * Math.PI) * damp;
            }
        }

        float readyLift = 0f;
        if (readyStartMs > 0L) {
            float rt = Math.min(1f, Math.max(0f, (now - readyStartMs) / 480f));
            float easeOut = 1f - (1f - rt) * (1f - rt) * (1f - rt);
            readyLift = -dp(6f) * easeOut;
            drawReadyRipple(canvas, cx, baseBookCy, easeOut);
        }

        drawFloorShadow(canvas, cx, baseBookCy + dp(45f), floatPhase);

        float bookW = dp(110f);
        float bookH = dp(72f);
        float bookCy = baseBookCy + floatY + boingY + readyLift;

        canvas.save();
        canvas.translate(cx, bookCy);
        canvas.scale(scaleX, scaleY);
        drawBookBody(canvas, bookW, bookH, tSec);
        canvas.restore();

        drawXiaoCrest(canvas, cx, bookCy + bookH * 0.5f + dp(1f), scaleX, scaleY);
        drawCampusBubbles(canvas, cx, baseBookCy - bookH * 0.36f, tSec);

        if (boingStartMs > 0L) {
            float st = (now - boingStartMs) / 560f;
            if (st >= 0f && st < 1f) {
                drawSparks(canvas, cx, baseBookCy - dp(6f), st);
            }
        }
    }

    private void drawFloorShadow(Canvas canvas, float cx, float cy, float floatPhase) {
        float factor = 1f - 0.16f * (0.5f + 0.5f * floatPhase);
        float rx = dp(48f) * factor;
        float ry = dp(7.5f) * factor;
        int alpha = Math.round((isDark ? 92 : 66) * factor);
        int centerCol = isDark ? Color.argb(alpha, 56, 189, 248) : Color.argb(alpha, 37, 99, 235);
        paint.setStyle(Paint.Style.FILL);
        paint.setShader(new RadialGradient(cx, cy, rx, centerCol, Color.TRANSPARENT, Shader.TileMode.CLAMP));
        canvas.save();
        canvas.translate(cx, cy);
        canvas.scale(1f, ry / Math.max(1f, rx));
        canvas.drawCircle(0f, 0f, rx, paint);
        canvas.restore();
        paint.setShader(null);
    }

    private void drawReadyRipple(Canvas canvas, float cx, float cy, float p) {
        float r = dp(32f) + dp(58f) * p;
        int alpha = Math.round(180 * (1f - p));
        if (alpha <= 0) return;
        strokePaint.setShader(null);
        strokePaint.setStrokeWidth(dp(2.5f) * (1f - 0.4f * p));
        strokePaint.setColor(isDark ? Color.argb(alpha, 56, 189, 248) : Color.argb(alpha, 59, 130, 246));
        canvas.drawCircle(cx, cy, r, strokePaint);
    }

    private void drawBookBody(Canvas canvas, float bookW, float bookH, float tSec) {
        float halfW = bookW * 0.5f;
        float halfH = bookH * 0.5f;

        rect.set(-halfW, -halfH, halfW, halfH);
        paint.setStyle(Paint.Style.FILL);
        paint.setShader(new LinearGradient(
                -halfW, -halfH, halfW, halfH,
                new int[]{Color.parseColor("#3B82F6"), Color.parseColor("#2563EB"), Color.parseColor("#4F46E5")},
                new float[]{0f, 0.52f, 1f},
                Shader.TileMode.CLAMP
        ));
        canvas.drawRoundRect(rect, dp(10.5f), dp(10.5f), paint);
        paint.setShader(null);

        strokePaint.setColor(Color.argb(128, 255, 255, 255));
        strokePaint.setStrokeWidth(dp(1.2f));
        rect.inset(dp(0.8f), dp(0.8f));
        canvas.drawRoundRect(rect, dp(10f), dp(10f), strokePaint);

        float pagePadX = dp(5.5f);
        float pagePadTop = dp(4.5f);
        float pagePadBot = dp(6.2f);
        float pageW = halfW - pagePadX - dp(1f);
        float pageTop = -halfH + pagePadTop;
        float pageBot = halfH - pagePadBot;

        int pageTopCol = isDark ? Color.parseColor("#E8F0FF") : Color.parseColor("#FFFFFF");
        int pageBotCol = isDark ? Color.parseColor("#CBD9F6") : Color.parseColor("#EEF4FF");
        int lineCol = isDark ? Color.argb(85, 37, 99, 235) : Color.argb(54, 37, 99, 235);

        rect.set(-halfW + pagePadX, pageTop, -dp(1f), pageBot);
        paint.setShader(new LinearGradient(0f, pageTop, 0f, pageBot, pageTopCol, pageBotCol, Shader.TileMode.CLAMP));
        canvas.drawRoundRect(rect, dp(4f), dp(4f), paint);
        paint.setShader(null);
        drawPageLines(canvas, rect.left + dp(7f), rect.right - dp(7f), pageTop + dp(10.5f), pageBot - dp(11.5f), lineCol);

        rect.set(dp(1f), pageTop, halfW - pagePadX, pageBot);
        paint.setShader(new LinearGradient(0f, pageTop, 0f, pageBot, pageTopCol, pageBotCol, Shader.TileMode.CLAMP));
        canvas.drawRoundRect(rect, dp(4f), dp(4f), paint);
        paint.setShader(null);
        drawPageLines(canvas, rect.left + dp(7f), rect.right - dp(7f), pageTop + dp(10.5f), pageBot - dp(11.5f), lineCol);

        rect.set(-dp(4.5f), pageTop, dp(4.5f), pageBot);
        paint.setShader(new LinearGradient(
                -dp(4.5f), 0f, dp(4.5f), 0f,
                new int[]{Color.TRANSPARENT, Color.argb(56, 30, 58, 138), Color.TRANSPARENT},
                new float[]{0f, 0.5f, 1f},
                Shader.TileMode.CLAMP
        ));
        canvas.drawRect(rect, paint);
        paint.setShader(null);

        float[] phases = new float[3];
        for (int i = 0; i < 3; i++) {
            phases[i] = ((tSec / FLIP_CYCLE_SEC) + i / 3f) % 1f;
        }
        int[] order = new int[]{0, 1, 2};
        for (int i = 0; i < 2; i++) {
            for (int j = i + 1; j < 3; j++) {
                if (Math.sin(phases[order[i]] * Math.PI) > Math.sin(phases[order[j]] * Math.PI)) {
                    int tmp = order[i];
                    order[i] = order[j];
                    order[j] = tmp;
                }
            }
        }
        for (int idx : order) {
            drawFlippingLeaf(canvas, phases[idx], pageW, pageTop, pageBot, lineCol);
        }
    }

    private void drawFlippingLeaf(Canvas canvas, float rawP, float pageW, float pageTop, float pageBot, int lineCol) {
        float p = rawP < 0.5f
                ? 2f * rawP * rawP
                : 1f - (float) Math.pow(-2f * rawP + 2f, 2.0) * 0.5f;

        double angle = p * Math.PI;
        float cosA = (float) Math.cos(angle);
        float sinA = (float) Math.sin(angle);
        float edgeX = cosA * pageW;
        float arcLift = sinA * dp(9f);

        path.reset();
        path.moveTo(0f, pageTop);
        path.quadTo(edgeX * 0.52f, pageTop - arcLift * 0.85f, edgeX, pageTop - arcLift * 0.45f);
        path.lineTo(edgeX, pageBot - arcLift * 0.45f);
        path.quadTo(edgeX * 0.52f, pageBot - arcLift * 0.85f, 0f, pageBot);
        path.close();

        int shade = Math.round(255 - 24 * sinA);
        int cOuter = isDark
                ? Color.rgb(Math.max(185, shade - 18), Math.max(200, shade - 8), 255)
                : Color.rgb(shade, Math.min(255, shade + 2), 255);
        int cSpine = isDark ? Color.parseColor("#C6D7FB") : Color.parseColor("#E4EEFF");

        paint.setStyle(Paint.Style.FILL);
        paint.setShader(new LinearGradient(0f, 0f, edgeX, 0f, cSpine, cOuter, Shader.TileMode.CLAMP));
        canvas.drawPath(path, paint);
        paint.setShader(null);

        strokePaint.setColor(Color.argb(Math.round(50 + 44 * sinA), 37, 99, 235));
        strokePaint.setStrokeWidth(dp(0.9f));
        canvas.drawPath(path, strokePaint);

        float absW = Math.abs(edgeX);
        if (absW > dp(14f)) {
            float l = Math.min(0f, edgeX) + absW * 0.16f;
            float r = Math.max(0f, edgeX) - absW * 0.16f;
            int lAlpha = Math.round(Color.alpha(lineCol) * Math.min(1f, (absW - dp(14f)) / dp(20f)));
            drawPageLines(canvas, l, r, pageTop + dp(10.5f) - arcLift * 0.42f, pageBot - dp(11.5f) - arcLift * 0.42f,
                    Color.argb(lAlpha, Color.red(lineCol), Color.green(lineCol), Color.blue(lineCol)));
        }
    }

    private void drawPageLines(Canvas canvas, float left, float right, float top, float bottom, int color) {
        if (right - left < dp(4f)) return;
        strokePaint.setColor(color);
        strokePaint.setStrokeWidth(dp(2.2f));
        int count = 4;
        float step = (bottom - top) / (count - 1);
        for (int i = 0; i < count; i++) {
            float y = top + i * step;
            float endX = (i == count - 1) ? left + (right - left) * 0.68f : right;
            canvas.drawLine(left, y, endX, y, strokePaint);
        }
    }

    private void drawXiaoCrest(Canvas canvas, float cx, float cy, float scaleX, float scaleY) {
        float size = dp(27f);
        float half = size * 0.5f;
        canvas.save();
        canvas.translate(cx, cy);
        canvas.scale(scaleX, scaleY);

        rect.set(-half - dp(2.4f), -half - dp(2.4f), half + dp(2.4f), half + dp(2.4f));
        paint.setStyle(Paint.Style.FILL);
        paint.setShader(null);
        paint.setColor(isDark ? Color.argb(235, 15, 23, 42) : Color.argb(245, 255, 255, 255));
        canvas.drawRoundRect(rect, dp(10.5f), dp(10.5f), paint);

        rect.set(-half, -half, half, half);
        paint.setShader(new LinearGradient(
                -half, -half, half, half,
                Color.parseColor("#2563EB"), Color.parseColor("#4F46E5"),
                Shader.TileMode.CLAMP
        ));
        canvas.drawRoundRect(rect, dp(8.5f), dp(8.5f), paint);
        paint.setShader(null);

        textPaint.setColor(Color.WHITE);
        textPaint.setTextSize(dp(13f));
        Paint.FontMetrics fm = textPaint.getFontMetrics();
        float textY = -(fm.ascent + fm.descent) * 0.5f;
        canvas.drawText("校", 0f, textY, textPaint);

        canvas.restore();
    }

    private void drawCampusBubbles(Canvas canvas, float originX, float originY, float tSec) {
        final float[] targetX = new float[]{-dp(46f), dp(44f), -dp(22f), dp(24f), 0f};
        final float[] targetY = new float[]{-dp(72f), -dp(66f), -dp(84f), -dp(82f), -dp(92f)};
        final float[] phases = new float[]{0f, 0.2f, 0.4f, 0.6f, 0.8f};

        float radius = dp(14.5f);
        for (int i = 0; i < 5; i++) {
            float p = ((tSec / BUBBLE_CYCLE_SEC) + phases[i]) % 1f;
            float alpha;
            float sc;
            if (p < 0.18f) {
                float k = p / 0.18f;
                alpha = k;
                sc = 0.32f + 0.76f * k;
            } else if (p < 0.74f) {
                alpha = 1f;
                sc = 1.08f - 0.12f * ((p - 0.18f) / 0.56f);
            } else {
                float k = (p - 0.74f) / 0.26f;
                alpha = Math.max(0f, 1f - k);
                sc = 0.96f - 0.38f * k;
            }
            if (alpha <= 0.02f) continue;

            float easeP = 1f - (1f - p) * (1f - p);
            float bx = originX + targetX[i] * easeP + (float) Math.sin(p * Math.PI * 2.0) * dp(2.2f);
            float by = originY + targetY[i] * p - dp(10f) * p;

            canvas.save();
            canvas.translate(bx, by);
            canvas.scale(sc, sc);

            int aInt = Math.round(alpha * 255);
            if (i == 4) {
                paint.setStyle(Paint.Style.FILL);
                paint.setShader(new RadialGradient(0f, 0f, radius * 1.45f,
                        Color.argb(Math.round(alpha * 95), 56, 189, 248), Color.TRANSPARENT, Shader.TileMode.CLAMP));
                canvas.drawCircle(0f, 0f, radius * 1.45f, paint);

                paint.setShader(new LinearGradient(
                        -radius, -radius, radius, radius,
                        new int[]{Color.parseColor("#06B6D4"), Color.parseColor("#2563EB"), Color.parseColor("#4F46E5")},
                        null, Shader.TileMode.CLAMP
                ));
                paint.setAlpha(aInt);
                canvas.drawCircle(0f, 0f, radius, paint);
                paint.setShader(null);
                paint.setAlpha(255);

                strokePaint.setColor(Color.argb(Math.round(alpha * 125), 255, 255, 255));
                strokePaint.setStrokeWidth(dp(1f));
                canvas.drawCircle(0f, 0f, radius - dp(0.5f), strokePaint);
            } else {
                paint.setStyle(Paint.Style.FILL);
                paint.setShader(null);
                paint.setColor(Color.argb(Math.round(alpha * (isDark ? 70 : 28)), 15, 23, 42));
                canvas.drawCircle(0f, dp(2f), radius, paint);

                paint.setColor(isDark
                        ? Color.argb(Math.round(alpha * 236), 30, 41, 59)
                        : Color.argb(Math.round(alpha * 246), 255, 255, 255));
                canvas.drawCircle(0f, 0f, radius, paint);

                strokePaint.setColor(isDark
                        ? Color.argb(Math.round(alpha * 78), 148, 163, 184)
                        : Color.argb(Math.round(alpha * 34), 37, 99, 235));
                strokePaint.setStrokeWidth(dp(1f));
                canvas.drawCircle(0f, 0f, radius, strokePaint);
            }

            drawBubbleIcon(canvas, i, alpha);
            canvas.restore();
        }
    }

    private void drawBubbleIcon(Canvas canvas, int type, float alpha) {
        int a = Math.round(alpha * 255);
        strokePaint.setStrokeWidth(dp(1.6f));
        float r = dp(5.5f);
        switch (type) {
            case 0:
                strokePaint.setColor(isDark ? Color.argb(a, 56, 189, 248) : Color.argb(a, 2, 132, 199));
                rect.set(-r, -r + dp(1f), r, r);
                canvas.drawRoundRect(rect, dp(2f), dp(2f), strokePaint);
                canvas.drawLine(-r, -dp(1.2f), r, -dp(1.2f), strokePaint);
                canvas.drawLine(-dp(2.5f), -r - dp(0.6f), -dp(2.5f), -r + dp(1.8f), strokePaint);
                canvas.drawLine(dp(2.5f), -r - dp(0.6f), dp(2.5f), -r + dp(1.8f), strokePaint);
                break;
            case 1:
                strokePaint.setColor(isDark ? Color.argb(a, 251, 191, 36) : Color.argb(a, 217, 119, 6));
                path.reset();
                path.moveTo(-dp(4.8f), dp(2.8f));
                path.quadTo(-dp(3.8f), dp(1.4f), -dp(3.5f), -dp(1.2f));
                path.cubicTo(-dp(3.5f), -dp(5f), dp(3.5f), -dp(5f), dp(3.5f), -dp(1.2f));
                path.quadTo(dp(3.8f), dp(1.4f), dp(4.8f), dp(2.8f));
                path.close();
                canvas.drawPath(path, strokePaint);
                canvas.drawLine(-dp(1.4f), dp(4.8f), dp(1.4f), dp(4.8f), strokePaint);
                break;
            case 2:
                strokePaint.setColor(isDark ? Color.argb(a, 52, 211, 153) : Color.argb(a, 5, 150, 105));
                rect.set(-r, -r, r, r);
                canvas.drawRoundRect(rect, dp(2.8f), dp(2.8f), strokePaint);
                path.reset();
                path.moveTo(-dp(2.7f), dp(0.2f));
                path.lineTo(-dp(0.6f), dp(2.3f));
                path.lineTo(dp(3.1f), -dp(2.1f));
                canvas.drawPath(path, strokePaint);
                break;
            case 3:
                strokePaint.setColor(isDark ? Color.argb(a, 129, 140, 248) : Color.argb(a, 79, 70, 229));
                path.reset();
                path.moveTo(0f, -dp(3.6f));
                path.quadTo(-dp(3f), -dp(5f), -dp(5.5f), -dp(3.8f));
                path.lineTo(-dp(5.5f), dp(4f));
                path.quadTo(-dp(3f), dp(3f), 0f, dp(4.4f));
                path.quadTo(dp(3f), dp(3f), dp(5.5f), dp(4f));
                path.lineTo(dp(5.5f), -dp(3.8f));
                path.quadTo(dp(3f), -dp(5f), 0f, -dp(3.6f));
                canvas.drawPath(path, strokePaint);
                canvas.drawLine(0f, -dp(3.6f), 0f, dp(4.4f), strokePaint);
                break;
            default:
                paint.setStyle(Paint.Style.FILL);
                paint.setShader(null);
                paint.setColor(Color.argb(a, 255, 255, 255));
                path.reset();
                float sOuter = dp(6.4f);
                float sInner = dp(2.1f);
                path.moveTo(0f, -sOuter);
                path.lineTo(sInner, -sInner);
                path.lineTo(sOuter, 0f);
                path.lineTo(sInner, sInner);
                path.lineTo(0f, sOuter);
                path.lineTo(-sInner, sInner);
                path.lineTo(-sOuter, 0f);
                path.lineTo(-sInner, -sInner);
                path.close();
                canvas.drawPath(path, paint);
                break;
        }
    }

    private void drawSparks(Canvas canvas, float cx, float cy, float p) {
        float ease = 1f - (1f - p) * (1f - p) * (1f - p);
        float alpha = Math.max(0f, 1f - p);
        float r = dp(3.8f) * (1f - 0.65f * p);
        paint.setStyle(Paint.Style.FILL);
        paint.setShader(null);
        for (int i = 0; i < SPARK_COUNT; i++) {
            float sx = cx + sparkDx[i] * ease;
            float sy = cy + sparkDy[i] * ease + dp(10f) * p * p;
            int col = sparkColor[i];
            paint.setColor(Color.argb(Math.round(alpha * 255), Color.red(col), Color.green(col), Color.blue(col)));
            canvas.drawCircle(sx, sy, r, paint);
        }
    }

    private float dp(float v) {
        return v * density;
    }
}
