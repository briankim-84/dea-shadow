#!/usr/bin/env python3
"""로컬 확인용 서버 (Range 지원) — python -m http.server 는 영상 seek이 안 되므로 이걸 쓸 것.
사용: shadow 폴더에서  python serve.py  →  http://localhost:8000/"""
import os, re, http.server, socketserver
class H(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        path=self.translate_path(self.path)
        if os.path.isdir(path): return super().send_head()
        rng=self.headers.get('Range')
        if not rng or not os.path.isfile(path): return super().send_head()
        m=re.match(r'bytes=(\d*)-(\d*)',rng)
        if not m: return super().send_head()
        size=os.path.getsize(path)
        a=int(m.group(1)) if m.group(1) else 0
        b=int(m.group(2)) if m.group(2) else size-1
        b=min(b,size-1)
        if a>b: self.send_error(416); return None
        f=open(path,'rb'); f.seek(a)
        self.send_response(206)
        self.send_header('Content-Type',self.guess_type(path))
        self.send_header('Accept-Ranges','bytes')
        self.send_header('Content-Range',f'bytes {a}-{b}/{size}')
        self.send_header('Content-Length',str(b-a+1))
        self.end_headers()
        self._range_len=b-a+1
        return f
    def copyfile(self,src,dst):
        n=getattr(self,'_range_len',None)
        if n is None: return super().copyfile(src,dst)
        while n>0:
            buf=src.read(min(65536,n))
            if not buf: break
            dst.write(buf); n-=len(buf)
        self._range_len=None
with socketserver.ThreadingTCPServer(("",8000),H) as s:
    print("Serving with Range support → http://localhost:8000/")
    s.serve_forever()
