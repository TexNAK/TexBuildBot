#!/usr/bin/env bash
cd /data
latexmk -f -pdf -xelatex -shell-escape -interaction=nonstopmode -halt-on-error "$@"
