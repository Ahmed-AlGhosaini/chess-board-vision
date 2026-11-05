"""Local web server behind the chessvision UI: engines, screenshot import, game databases."""
import os

# The square classifier multiplies small matrices, which gain nothing from several threads. While other programs
# keep the CPU busy, waiting on each other's threads makes a read of a captured board about twice as slow.
# Must be set before numpy is first imported.
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
