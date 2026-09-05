package com.wisdommedical.accounting;
import android.app.*; import android.os.*; import android.webkit.*; import android.view.*;
public class MainActivity extends Activity {
 WebView web;
 @Override public void onCreate(Bundle b){super.onCreate(b); web=new WebView(this); web.getSettings().setJavaScriptEnabled(true); web.getSettings().setDomStorageEnabled(true); web.setWebViewClient(new WebViewClient()); web.loadUrl("https://wisdom-medical-accounting-production.up.railway.app/"); setContentView(web);}
 @Override public void onBackPressed(){if(web.canGoBack()) web.goBack(); else super.onBackPressed();}
}
