import numpy as np
from pathlib import Path
import os
import subprocess
import time
import re
import threading
import queue
from collections import deque

class Receiver:
    def __init__(self):
        self.channels = 8
        self.bits_per_sample = 16
        self.sample_rate = 16000
        # [核心设置] 0.5s 低延迟切片
        self.deal_time = 0.5
        
        self.bytes_per_frame = (self.bits_per_sample // 8) * self.channels
        self.bytes_per_sec = self.bytes_per_frame * self.sample_rate
        self.bytes_deal_time = int(self.bytes_per_sec * self.deal_time)
        self.local_dir = Path('./cache/')
        self.local_dir.mkdir(exist_ok=True)
        self.remote_dir = '/data/build/'
        self.chunk = 0
        self.max_sec = 120
        self.max_chunk = int(self.max_sec // self.deal_time)
        self.data_queue = queue.Queue(maxsize=10)
        self.stop_event = threading.Event()
        self.is_recording = False
        self.stop_record()
        
        print(f"--- Recorder Config ---")
        print(f"Deal Time: {self.deal_time}s")
        print(f"Sample Rate: {self.sample_rate}")
        print(f"Expected Bytes per Chunk: {self.bytes_deal_time}")
        print(f"-----------------------")
        
        
    def start_record(self):
        start_time = time.time()
        timeout = 15.0
        check_interval = 0.1  # [优化] 将 0.5 改为 0.1，加快检测速度，减少初始延迟
        
        while True:
            current_time = time.time()
            elapsed = current_time - start_time
            
            # 推送配置 (启动录音)
            self.push_file(self.local_dir / "user_cfg1.ini", self.remote_dir + "user_cfg.ini")
            
            # 检查文件是否存在
            check_file_cmd = f'adb shell "[ -f {self.remote_dir}origin.pcm ] && echo "exists" || echo "missing""'
            try:
                result = os.popen(check_file_cmd).read().strip()
            except Exception:
                result = "error"
            
            # print(f"检查状态: {result} | 已等待: {elapsed:.1f}s")
            
            if result == "exists":
                # 检查是否已有足够数据
                if self.check_record():
                    print('录音文件已就绪，准备开始...')
                    return True
            
            if elapsed >= timeout:
                print(f"超时未检测到有效录音 (等待{timeout}s)")
                return False
            
            time.sleep(check_interval)
    
    def check_record(self):
        # [修复] 增加等待轮次，且超时返回 False
        # 0.5s deal_time 意味着我们需要等待至少 0.5s 的数据量
        # 给 20 次机会 (20 * 0.1s = 2s)，足够覆盖 0.5s 的生成时间
        max_retries = 20
        i = 0
        while i < max_retries:
            try:
                get_size_cmd = f'adb shell ls -l {self.remote_dir}origin.pcm | awk \'{{print $5}}\''
                size_str = os.popen(get_size_cmd).read().strip()
                if size_str and size_str.isdigit():
                    file_size = int(size_str)
                    if file_size >= self.bytes_deal_time:
                        print(f'录音准备就绪 (Size: {file_size})')
                        return True
            except Exception as e:
                print(f"check_record error: {e}")
                
            i += 1
            time.sleep(0.1)
        
        return False # 超时返回 False
        
    def stop_record(self):
        print('停止录音')
        self.push_file(self.local_dir / "user_cfg0.ini", self.remote_dir + "user_cfg.ini")
        self.del_cache()
        self.chunk = 0
        return True

    def rm_record(self, file):
        subprocess.run(
            ["adb", "shell", "rm", f"{self.remote_dir}{file}"],
            capture_output=True, text=True
        )

    def dd_data(self, chunk):
        # [优化] 使用 subprocess 替代 os.system 以便调试，忽略错误防止 crash
        cmd = ["adb", "shell", "dd",
               f"if={self.remote_dir}origin.pcm",
               f"bs={self.bytes_deal_time}",
               "count=1",
               f"skip={chunk}",
               f"of={self.remote_dir}data{chunk}"]
        
        # 这里的 dd 输出 stderr 包含记录数，不算是错误，所以不 check=True
        subprocess.run(cmd, capture_output=True)
        return True

    def pull_file(self, remote_path, local_path):
        result = subprocess.run(
            ["adb", "pull", f"{remote_path}", f"{local_path}"],
            capture_output=True, text=True
        )
        if result.returncode != 0:
            # 如果 pull 失败 (比如文件不存在)，打印警告
            # print(f"Pull failed for {remote_path}: {result.stderr.strip()}")
            return False
        return True

    def push_file(self, local_path, remote_path):
        subprocess.run(
            ["adb", "push", f"{local_path}", f"{remote_path}"],
            capture_output=True, text=True
        )

    def del_data_cache(self):
        for entry in self.local_dir.iterdir():
            if re.match(r'^data\d+$', entry.name):
                try:
                    os.remove(entry)
                    self.rm_record(entry.name)
                except Exception:
                    pass
        print('已清理缓存')

    def del_cache(self):
        print('清理缓存')
        self.rm_record("origin.pcm")
        self.del_data_cache()
        

    def record_loop(self):
        if not self.start_record():
            print("Recorder start failed (timeout/offline).")
            self.data_queue.put((-1, "DEVICE_ERROR"))
            self.is_recording = False
            self.stop_event.set()
            return

#        # [新增] 核心逻辑：跳过历史积压数据，追赶最新进度 (Jump to Live)
#        try:
#            get_size_cmd = f'adb shell ls -l {self.remote_dir}origin.pcm | awk \'{{print $5}}\''
#            size_str = os.popen(get_size_cmd).read().strip()
#            if size_str and size_str.isdigit():
#                current_size = int(size_str)
#                # 计算已生成的完整块数量
#                # 例如：文件大小 163840，块大小 128000 -> existing_chunks = 1
#                existing_chunks = current_size // self.bytes_deal_time
#                
#                if existing_chunks > 0:
#                    # 直接将 chunk 指针指向下一个待生成的块
#                    # 比如已有 Chunk 0 (0-0.5s)，我们将 self.chunk 设为 1
#                    # 这样程序会直接去读 Chunk 1 (0.5-1.0s)，跳过积压的 Chunk 0
#                    self.chunk = existing_chunks
#                    print(f"【低延迟优化】检测到积压数据，自动跳过 {existing_chunks} 个块 ({(existing_chunks * self.deal_time):.1f}s)，直接读取最新数据。")
#        except Exception as e:
#            print(f"Sync error: {e}")

        try:
            while self.is_recording and self.chunk < self.max_chunk:
                chunk_start = time.time()
                
                # 1. 尝试在设备上切分数据
                self.dd_data(self.chunk)
                
                local_path = self.local_dir / f"data{self.chunk}"
                remote_path = f"{self.remote_dir}data{self.chunk}"
                
                # 2. 拉取文件
                pull_success = self.pull_file(remote_path, str(local_path))
                
                # 3. 读取数据
                try:
                    if not pull_success or not local_path.exists():
                        # 如果文件还没拉取到，说明录音速度还没跟上，稍微等一下
                        # 这在 Jump to Live 后很常见，因为我们正在等最新的数据生成
                        time.sleep(0.05)
                        continue

                    data = self.read_pcm(self.chunk)
                    
                    if self.data_queue.full():
                        self.data_queue.get()
                    self.data_queue.put((self.chunk, data))
                    
                    self.chunk += 1
                    
                except Exception as e:
                    print(f"Error processing chunk {self.chunk}: {e}")
                    time.sleep(0.5) # 出错时稍微避让
                
                if self.chunk >= self.max_chunk:
                    print("Reached maximum recording chunks.")
                    break
                
                # 动态休眠：如果处理太快，就休息一下等待新数据
                elapsed = time.time() - chunk_start
                sleep_time = max(0, self.deal_time - elapsed)
                if sleep_time > 0:
                    time.sleep(sleep_time)
                    
        finally:
            self.stop_record()
            self.is_recording = False
            self.stop_event.set()

    def read_pcm(self, chunk):
        file_path = self.local_dir / f"data{chunk}"
        # 再次检查文件是否存在
        if not file_path.exists():
            raise FileNotFoundError(f"File missing: {file_path}")
            
        with open(file_path, 'rb') as f:
            raw_data = f.read()

        if len(raw_data) == 0:
            raise ValueError("Empty data chunk received")

        dtype = np.int16 if self.bits_per_sample == 16 else np.float32
        data = np.frombuffer(raw_data, dtype=dtype).reshape((-1, self.channels))
        print(data.shape)
        return data

    def start_recording(self):
        if not self.is_recording:
            self.is_recording = True
            self.stop_event.clear()
            self.recording_thread = threading.Thread(target=self.record_loop)
            self.recording_thread.start()

    def stop_recording(self):
        self.is_recording = False
        if hasattr(self, 'recording_thread'):
            self.recording_thread.join()
        self.stop_record()

if __name__ == '__main__':
    receiver = Receiver()
    try:
        receiver.start_recording()
        while receiver.is_recording:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        receiver.stop_recording()
