FROM python:3.12-slim
WORKDIR /opt/yolo-sandbox
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
USER 65534:65534
WORKDIR /work
ENV PYTHONDONTWRITEBYTECODE=1 MPLBACKEND=Agg HOME=/tmp
CMD ["python", "-I", "-B", "run.py"]
