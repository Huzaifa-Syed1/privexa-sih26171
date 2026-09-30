import time
from fastapi.testclient import TestClient
from app.main import app

def run_benchmark():
    sizes = [5, 10, 25, 48]
    
    with TestClient(app) as client:
        for size in sizes:
            # Generate a mock scene graph
            nodes = []
            for i in range(size):
                nodes.append({
                    "id": f"n{i}",
                    "role": "textbox",
                    "type": "text",
                    "label": f"Field {i}",
                    "bbox": [0, i*20, 100, 20],
                    "filled": False,
                    "source": "dom"
                })
            nodes.append({
                "id": "btn",
                "role": "button",
                "label": "Submit",
                "bbox": [0, size*20, 100, 20],
                "source": "dom"
            })
            
            payload = {
                "version": "1.0",
                "url_hash": f"hash_{size}",
                "viewport": {"w": 1024, "h": 768},
                "timestamp": int(time.time()),
                "nodes": nodes,
                "focused_node_id": None,
                "task_context": "Fill out the registration form completely",
                "action_history": []
            }
            
            start_time = time.time()
            response = client.post("/plan", json=payload)
            end_time = time.time()
            
            print(f"--- Benchmark: {size}-field form ---")
            if response.status_code == 200:
                plan = response.json()
                print(f"Latency: {end_time - start_time:.2f}s")
                print(f"Planner Calls: 1 (batched {len(plan.get('actions', []))} actions)")
                print(f"Action Types: {[a.get('action') for a in plan.get('actions', [])]}")
            else:
                print(f"Error: {response.status_code} - {response.text}")
            print("\n")

if __name__ == "__main__":
    run_benchmark()
