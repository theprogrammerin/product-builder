# Structural placeholder — a real, bundled image build is Phase 1 work.
FROM ruby:3.3-slim

WORKDIR /app
COPY . .

# RUN bundle install  # left commented until this is a real, bundled app

CMD ["bin/rails", "server", "-b", "0.0.0.0"]
