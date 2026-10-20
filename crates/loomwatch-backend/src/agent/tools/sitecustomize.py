"""Names Python's own web requests after LoomWatch.

LoomWatch puts this file first on PYTHONPATH for the commands of an agent that may use the web.
Python's default name, "Python-urllib/3.x", is refused by some sites: Read the Docs, which hosts the
documentation of thousands of projects, answers it with 403. Those sites ask tools to name
themselves and say where to read about them, which this name does; it never claims to be a browser.

- A name the script sets itself still wins.
- urllib.request is named when the script imports it, never before: importing it here would slow
  every Python that doesn't.
- The sitecustomize this file hides, from the person's own Python or PYTHONPATH, still runs.
"""

import sys

USER_AGENT = "@USER_AGENT@"


def _name(request):
    """Gives urllib's openers LoomWatch's name in place of Python's."""
    director = request.OpenerDirector
    made = director.__init__

    def __init__(self, *args, **kwargs):
        made(self, *args, **kwargs)
        self.addheaders = [
            header for header in self.addheaders if header[0].lower() != "user-agent"
        ] + [("User-agent", USER_AGENT)]

    director.__init__ = __init__


class _NamesRequests(object):
    """Finds urllib.request as Python would, and names it once it has run."""

    @classmethod
    def find_spec(cls, name, path=None, target=None):
        if name != "urllib.request":
            return None
        for finder in sys.meta_path:
            find = getattr(finder, "find_spec", None)
            if finder is cls or find is None:
                continue
            spec = find(name, path, target)
            if spec is not None:
                break
        else:
            return None
        loader = spec.loader
        run = getattr(loader, "exec_module", None)
        # A loader that is a class serves every module it loads: leave it as it is.
        if run is None or isinstance(loader, type):
            return spec

        def exec_module(module):
            run(module)
            try:
                _name(module)
            except Exception:
                pass

        loader.exec_module = exec_module
        return spec


def _run_hidden_sitecustomize():
    """Runs the sitecustomize that this one hides further along the path, if there is one."""
    import importlib.machinery
    import os

    here = os.path.dirname(os.path.abspath(__file__))
    rest = [entry for entry in sys.path if os.path.abspath(entry or os.curdir) != here]
    spec = importlib.machinery.PathFinder.find_spec("sitecustomize", rest)
    if spec is None or spec.loader is None:
        return
    # Only now: importlib.util takes longer to import than the rest of this file.
    import importlib.util

    module = importlib.util.module_from_spec(spec)
    sys.modules["sitecustomize"] = module
    spec.loader.exec_module(module)


# Python 2 asks its finders for find_module, which this file has no use for.
if sys.version_info[0] >= 3:
    sys.meta_path.insert(0, _NamesRequests)
    _run_hidden_sitecustomize()
