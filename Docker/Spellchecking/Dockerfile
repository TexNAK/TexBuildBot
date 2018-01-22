FROM python:3

RUN apt-get update && apt-get install -f -y poppler-utils && apt-get clean

COPY ./spellchecker.py .

CMD ["python", "./spellchecker.py", "-o", "/data/output.md", "/data"]
