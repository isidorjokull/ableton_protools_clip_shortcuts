from .pt_bridge import PTBridge


def create_instance(c_instance):
    return PTBridge(c_instance)
