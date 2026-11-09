# Synthetic antivirus transport for integration tests only.
import socketserver, struct
class Handler(socketserver.BaseRequestHandler):
 def exact(self,n):
  result=b''
  while len(result)<n:
   part=self.request.recv(n-len(result))
   if not part: return None
   result+=part
  return result
 def handle(self):
  if self.exact(10)!=b'zINSTREAM\0': return
  infected=False
  while True:
   raw=self.exact(4)
   if raw is None: return
   size=struct.unpack('!I',raw)[0]
   if not size: break
   data=self.exact(size)
   if data is None: return
   infected |= b'EICAR' in data
  self.request.sendall(b'stream: Eicar-Test-Signature FOUND\0' if infected else b'stream: OK\0')
class Server(socketserver.ThreadingTCPServer): allow_reuse_address=True
Server(('0.0.0.0',3310),Handler).serve_forever()
