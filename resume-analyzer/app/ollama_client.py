import requests
import time

OLLAMA_URL = "http://127.0.0.1:11434"
MODEL = "qwen3.5:9b"


def ask_ollama_chat(
    system_prompt: str,
    user_prompt: str,
    num_ctx: int = 16384,
    max_tokens: int = 2048,
    temperature: float = 0.0
) -> dict:
    """Отправляет запрос в Ollama через chat API."""
    
    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        "stream": False,
        "think": False,
        "options": {
            "num_ctx": num_ctx,
            "num_predict": max_tokens,
            "temperature": temperature
        }
    }
    
    start = time.time()
    
    try:
        response = requests.post(
            f"{OLLAMA_URL}/api/chat",
            json=payload,
            timeout=900
        )
        total_time = time.time() - start
        
        if response.status_code != 200:
            return {"error": response.text, "status_code": response.status_code}
        
        data = response.json()
        
        # ОТЛАДКА: печатаем полный ответ от Ollama
        print("\n" + "="*60)
        print("ПОЛНЫЙ ОТВЕТ ОТ OLLAMA:")
        print(str(data)[:2000])
        print("="*60 + "\n")
        
        message = data.get("message", {})
        content = message.get("content", "")
        
        return {
            "response": content,
            "prompt_tokens": data.get("prompt_eval_count", 0),
            "generated_tokens": data.get("eval_count", 0),
            "total_time_sec": round(total_time, 2)
        }
        
    except Exception as e:
        return {"error": f"Ошибка подключения к Ollama: {str(e)}"}