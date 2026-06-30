FROM maven:3.9-eclipse-temurin-17
WORKDIR /app
COPY . .
ENV BRIDGE_BASE_URL=http://mock:3099
RUN mvn -q -DskipTests package
CMD ["mvn", "-q", "exec:java"]
