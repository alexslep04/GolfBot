FROM python:3.14-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY game.py scoring.py rule_help.py server.py bot.py bot_workers.py accounts.py player_stats.py match_history.py RULES.md ./
COPY web ./web
RUN useradd --create-home golf && mkdir /app/data && chown golf:golf /app/data
USER golf
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
