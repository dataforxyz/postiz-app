#!/bin/bash

set -o xtrace

docker rmi localhost/postiz || true
docker build -t localhost/postiz -t localhost/postiz-devcontainer -f Dockerfile.dev .
