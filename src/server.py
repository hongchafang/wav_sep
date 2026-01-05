import os
import time
import threading
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from recorder import Receiver
from seperator import Separator
from collections import deque
import asyncio
import uvicorn
from fastapi import Request
from fastapi.staticfiles import StaticFiles
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.responses import FileResponse
CURRENT_WORK_DIR = os.getcwd()
# 拼接子目录
AUDIO_DIR = os.path.join(CURRENT_WORK_DIR, "audio_output")
if not os.path.exists(AUDIO_DIR):
    os.makedirs(AUDIO_DIR)
    print(f"Created audio directory: {AUDIO_DIR}")
else:
    print(f"Using audio directory: {AUDIO_DIR}")
app = FastAPI()
app.mount("/audio", StaticFiles(directory=AUDIO_DIR), name="audio")
#app.mount("/static", StaticFiles(directory="."), name="static")

# 全局状态管理
global_queue = deque(maxlen=10)
receiver = Receiver()
separator = Separator(receiver, global_queue)

@app.get("/labels_list.txt")
async def get_labels_file():
    file_path = "labels_list.txt"
    
    # 打印当前工作目录，确保你认为的文件位置和代码运行的位置一致
    print(f"Current working directory: {os.getcwd()}")
    
    if not os.path.exists(file_path):
        print(f"Error: {file_path} not found!")
        # 抛出 404 而不是让系统崩溃导致 500
        raise HTTPException(status_code=404, detail="Labels file not found")
    
    try:
        return FileResponse(
            path=file_path,
            filename="labels_list.txt",
            media_type='text/plain'
        )
    except Exception as e:
        print(f"Internal Server Error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
    
@app.get("/config.js")
async def get_config():
    return FileResponse("config.js")

@app.get("/spectrogram.js")
async def get_spec():
    return FileResponse("spectrogram.js")

@app.get("/waveform.js")
async def get_wave():
    return FileResponse("waveform.js")

@app.get("/app.js")
async def get_app():
    return FileResponse("app.js")
    
@app.get("/")
async def get():
    with open("index.html", "r", encoding="utf-8") as f:
        return HTMLResponse(f.read())

@app.get("/start_system")
async def start_system():
    if not receiver.is_recording:
        print("Starting System...")
        receiver.start_recording()
        separator.start_processing()
        return {"status": "started"}
    return {"status": "already_running"}

@app.get("/stop_system")
async def stop_system():
    print("Stopping System...")
    receiver.stop_recording()
    separator.stop_processing()
    return {"status": "stopped"}
    
@app.post("/set_target")
async def set_target_endpoint(request: Request):
    data = await request.json()
    new_tag = data.get("tag", "Speech")
    
    # 1. 设置新目标
    separator.set_target(new_tag)
    
    response_data = {"status": "success", "current_target": new_tag}
    
    # 2. [新增] 检查是否需要重处理
    # 如果系统未在录音 (is_recording=False) 且缓冲区有原始数据
    if not receiver.is_recording and len(separator.buffer_raw_ch0) > 0:
        print("Triggering reprocessing for stored audio...")
        try:
            # 调用重处理方法
            new_vis_data = separator.reprocess_stored_audio()
            if new_vis_data:
                response_data["reprocessed"] = True
                response_data["reprocessed_data"] = new_vis_data
        except Exception as e:
            print(f"Reprocessing failed: {e}")
            response_data["reprocess_error"] = str(e)
            
    return response_data
    
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("Frontend connected")
    try:
        while True:
            # 检查队列是否有数据
            if len(global_queue) > 0:
                # [核心修改] 使用 popleft() 而不是 get()
                # 注意：这里不需要 await，因为 popleft 是非阻塞的
                data = global_queue.popleft()
                
                # 发送给前端
                await websocket.send_json(data)
            else:
                # 队列空了，休息一下让出 CPU 资源
                await asyncio.sleep(0.01)
                
    except WebSocketDisconnect:
        print("Frontend disconnected")
    except Exception as e:
        print(f"WS Error: {e}")
@app.get("/reset_system")
async def reset_system_endpoint():
    print("Performing System Reset...")
    
    # 1. 强制停止录音和处理
    receiver.stop_recording()
    separator.stop_processing()
    
    # 2. 清空内存队列 (防止残留数据在下次启动时弹出)
    while not receiver.data_queue.empty():
        try:
            receiver.data_queue.get_nowait()
        except queue.Empty:
            break
            
    global_queue.clear()
    separator.reset_buffers()

    # 3. 物理删除音频文件
    # 稍微延迟一下，确保文件句柄已释放
    await asyncio.sleep(0.1)
    
    if os.path.exists(AUDIO_DIR):
        for filename in os.listdir(AUDIO_DIR):
            if filename.endswith(".wav"):
                file_path = os.path.join(AUDIO_DIR, filename)
                try:
                    os.remove(file_path)
                    print(f"Deleted: {filename}")
                except Exception as e:
                    print(f"Failed to delete {filename}: {e}")

    return {"status": "reset_done"}
if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
    
