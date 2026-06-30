FROM golang:1.22-alpine
WORKDIR /app
COPY . .
ENV BRIDGE_BASE_URL=http://mock:3099
RUN go build -o bridge-example .
CMD ["./bridge-example"]
